#include <napi.h>

#include <d3d11_1.h>
#include <dxgi1_2.h>
#include <windows.h>
#include <wrl/client.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <iomanip>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

#include "libmpv_runtime_probe.h"

using Microsoft::WRL::ComPtr;

namespace {

constexpr uint32_t kMinimumDimension = 16;
constexpr uint32_t kMaximumDimension = 8192;
constexpr uint32_t kMinimumPoolSize = 2;
constexpr uint32_t kMaximumPoolSize = 8;
constexpr auto kCompletionTimeout = std::chrono::milliseconds(250);

std::atomic<uint64_t> g_quarantined_states{0};

std::string HResultMessage(const char* operation, HRESULT result) {
  std::ostringstream output;
  output << operation << " failed (0x" << std::hex << std::uppercase
         << static_cast<uint32_t>(result) << ").";
  return output.str();
}

struct TextureSlot {
  ComPtr<ID3D11Texture2D> texture;
  ComPtr<ID3D11RenderTargetView> render_target;
  ComPtr<ID3D11Query> completion_query;
  HANDLE shared_handle = nullptr;
  uint64_t sequence = 0;
  bool electron_owned = false;

  ~TextureSlot() {
    if (shared_handle != nullptr) CloseHandle(shared_handle);
  }

  TextureSlot() = default;
  TextureSlot(const TextureSlot&) = delete;
  TextureSlot& operator=(const TextureSlot&) = delete;
};

struct ProducerState {
  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> context;
  ComPtr<ID3D11DeviceContext1> context1;
  std::vector<std::unique_ptr<TextureSlot>> slots;
  uint32_t width = 0;
  uint32_t height = 0;
  uint64_t next_sequence = 1;
  uint64_t dropped_frames = 0;
  uint64_t produced_frames = 0;
  bool unusable = false;

  size_t Outstanding() const {
    return static_cast<size_t>(std::count_if(slots.begin(), slots.end(),
      [](const auto& slot) { return slot->electron_owned; }));
  }
};

bool ReadBoundedUint32(const Napi::Object& options, const char* key,
                       uint32_t minimum, uint32_t maximum, uint32_t* output) {
  const Napi::Value value = options.Get(key);
  if (!value.IsNumber()) return false;
  const double number = value.As<Napi::Number>().DoubleValue();
  if (!std::isfinite(number) || std::floor(number) != number ||
      number < minimum || number > maximum) return false;
  *output = static_cast<uint32_t>(number);
  return true;
}

bool CreateTexturePool(ProducerState* state, uint32_t width, uint32_t height,
                       uint32_t pool_size, std::string* error) {
  if (state->Outstanding() != 0) {
    *error = "Cannot replace a texture pool while Electron references are outstanding.";
    return false;
  }

  std::vector<std::unique_ptr<TextureSlot>> next_slots;
  next_slots.reserve(pool_size);
  for (uint32_t index = 0; index < pool_size; ++index) {
    auto slot = std::make_unique<TextureSlot>();
    D3D11_TEXTURE2D_DESC description{};
    description.Width = width;
    description.Height = height;
    description.MipLevels = 1;
    description.ArraySize = 1;
    description.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    description.SampleDesc.Count = 1;
    description.Usage = D3D11_USAGE_DEFAULT;
    description.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
    // Chromium's D3D shared-image path uses SHARED + SHARED_NTHANDLE for BGRA
    // textures without a keyed mutex. Correctness therefore relies on the
    // explicit completion query above and on allReferencesReleased for reuse.
    description.MiscFlags = D3D11_RESOURCE_MISC_SHARED_NTHANDLE |
                            D3D11_RESOURCE_MISC_SHARED;

    HRESULT result = state->device->CreateTexture2D(&description, nullptr, &slot->texture);
    if (FAILED(result)) {
      *error = HResultMessage("ID3D11Device::CreateTexture2D", result);
      return false;
    }
    result = state->device->CreateRenderTargetView(slot->texture.Get(), nullptr, &slot->render_target);
    if (FAILED(result)) {
      *error = HResultMessage("ID3D11Device::CreateRenderTargetView", result);
      return false;
    }

    D3D11_QUERY_DESC query_description{};
    query_description.Query = D3D11_QUERY_EVENT;
    result = state->device->CreateQuery(&query_description, &slot->completion_query);
    if (FAILED(result)) {
      *error = HResultMessage("ID3D11Device::CreateQuery", result);
      return false;
    }

    ComPtr<IDXGIResource1> resource;
    result = slot->texture.As(&resource);
    if (FAILED(result)) {
      *error = HResultMessage("ID3D11Texture2D::QueryInterface(IDXGIResource1)", result);
      return false;
    }
    result = resource->CreateSharedHandle(
      nullptr,
      DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE,
      nullptr,
      &slot->shared_handle);
    if (FAILED(result)) {
      *error = HResultMessage("IDXGIResource1::CreateSharedHandle", result);
      return false;
    }
    next_slots.push_back(std::move(slot));
  }

  state->slots = std::move(next_slots);
  state->width = width;
  state->height = height;
  return true;
}

bool InitializeDevice(ProducerState* state, std::string* error) {
  const D3D_FEATURE_LEVEL requested_levels[] = {
    D3D_FEATURE_LEVEL_11_1,
    D3D_FEATURE_LEVEL_11_0,
  };
  D3D_FEATURE_LEVEL actual_level{};
  const UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
  HRESULT result = D3D11CreateDevice(
    nullptr,
    D3D_DRIVER_TYPE_HARDWARE,
    nullptr,
    flags,
    requested_levels,
    static_cast<UINT>(std::size(requested_levels)),
    D3D11_SDK_VERSION,
    &state->device,
    &actual_level,
    &state->context);
  if (FAILED(result)) {
    *error = HResultMessage("D3D11CreateDevice(hardware)", result);
    return false;
  }
  if (actual_level < D3D_FEATURE_LEVEL_11_0) {
    *error = "A D3D11 feature-level 11.0 hardware device is required.";
    return false;
  }
  result = state->context.As(&state->context1);
  if (FAILED(result)) {
    *error = HResultMessage("ID3D11DeviceContext::QueryInterface(ID3D11DeviceContext1)", result);
    return false;
  }
  return true;
}

class SyntheticTextureProducer final : public Napi::ObjectWrap<SyntheticTextureProducer> {
 public:
  static Napi::Object Initialize(Napi::Env env, Napi::Object exports) {
    Napi::Function constructor = DefineClass(env, "SyntheticTextureProducer", {
      InstanceMethod("nextFrame", &SyntheticTextureProducer::NextFrame),
      InstanceMethod("releaseFrame", &SyntheticTextureProducer::ReleaseFrame),
      InstanceMethod("resize", &SyntheticTextureProducer::Resize),
      InstanceMethod("getStats", &SyntheticTextureProducer::GetStats),
      InstanceMethod("destroy", &SyntheticTextureProducer::Destroy),
    });
    exports.Set("SyntheticTextureProducer", constructor);
    exports.Set("quarantinedStateCount", Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
      return Napi::Number::New(info.Env(), static_cast<double>(g_quarantined_states.load()));
    }));
    return exports;
  }

  explicit SyntheticTextureProducer(const Napi::CallbackInfo& info)
      : Napi::ObjectWrap<SyntheticTextureProducer>(info), state_(std::make_unique<ProducerState>()) {
    Napi::Env env = info.Env();
    if (info.Length() != 1 || !info[0].IsObject()) {
      Napi::TypeError::New(env, "SyntheticTextureProducer requires one options object.").ThrowAsJavaScriptException();
      state_.reset();
      return;
    }
    Napi::Object options = info[0].As<Napi::Object>();
    uint32_t width = 0;
    uint32_t height = 0;
    uint32_t pool_size = 0;
    if (!ReadBoundedUint32(options, "width", kMinimumDimension, kMaximumDimension, &width) ||
        !ReadBoundedUint32(options, "height", kMinimumDimension, kMaximumDimension, &height) ||
        !ReadBoundedUint32(options, "poolSize", kMinimumPoolSize, kMaximumPoolSize, &pool_size)) {
      Napi::RangeError::New(env, "width/height must be 16..8192 and poolSize must be 2..8.").ThrowAsJavaScriptException();
      state_.reset();
      return;
    }
    pool_size_ = pool_size;
    std::string error;
    if (!InitializeDevice(state_.get(), &error) ||
        !CreateTexturePool(state_.get(), width, height, pool_size_, &error)) {
      Napi::Error::New(env, error).ThrowAsJavaScriptException();
      state_.reset();
    }
  }

  ~SyntheticTextureProducer() override { DestroyNative(); }

 private:
  Napi::Value NextFrame(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!state_ || state_->unusable) {
      Napi::Error::New(env, "The synthetic texture producer is unavailable.").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    auto iterator = std::find_if(state_->slots.begin(), state_->slots.end(),
      [](const auto& slot) { return !slot->electron_owned; });
    if (iterator == state_->slots.end()) {
      state_->dropped_frames += 1;
      return env.Null();
    }

    TextureSlot* slot = iterator->get();
    const uint64_t sequence = state_->next_sequence++;
    const float phase = static_cast<float>((sequence % 240) / 240.0);
    const float base_color[4] = {
      0.03f + 0.12f * std::sin(phase * 6.2831853f) * std::sin(phase * 6.2831853f),
      0.04f,
      0.12f + 0.18f * phase,
      1.0f,
    };
    const float bar_color[4] = {0.15f, 0.85f, 0.68f, 1.0f};
    state_->context->ClearRenderTargetView(slot->render_target.Get(), base_color);
    const LONG bar_width = std::max<LONG>(8, static_cast<LONG>(state_->width / 10));
    const LONG travel = std::max<LONG>(1, static_cast<LONG>(state_->width) - bar_width);
    const LONG left = static_cast<LONG>((sequence * 13) % static_cast<uint64_t>(travel));
    const D3D11_RECT bar{left, 0, std::min<LONG>(left + bar_width, state_->width), static_cast<LONG>(state_->height)};
    state_->context1->ClearView(slot->render_target.Get(), bar_color, &bar, 1);
    state_->context->End(slot->completion_query.Get());
    state_->context->Flush();

    const auto deadline = std::chrono::steady_clock::now() + kCompletionTimeout;
    while (true) {
      const HRESULT result = state_->context->GetData(
        slot->completion_query.Get(), nullptr, 0, D3D11_ASYNC_GETDATA_DONOTFLUSH);
      if (result == S_OK) break;
      if (result != S_FALSE) {
        state_->unusable = true;
        Napi::Error::New(env, HResultMessage("ID3D11DeviceContext::GetData", result)).ThrowAsJavaScriptException();
        return env.Undefined();
      }
      if (std::chrono::steady_clock::now() >= deadline) {
        state_->unusable = true;
        Napi::Error::New(env, "Timed out waiting for D3D11 producer completion.").ThrowAsJavaScriptException();
        return env.Undefined();
      }
      Sleep(1);
    }

    slot->sequence = sequence;
    slot->electron_owned = true;
    state_->produced_frames += 1;
    const auto timestamp = std::chrono::duration_cast<std::chrono::microseconds>(
      std::chrono::steady_clock::now().time_since_epoch()).count();

    Napi::Object frame = Napi::Object::New(env);
    frame.Set("slot", Napi::Number::New(env, static_cast<double>(std::distance(state_->slots.begin(), iterator))));
    frame.Set("sequence", Napi::Number::New(env, static_cast<double>(sequence)));
    frame.Set("width", Napi::Number::New(env, state_->width));
    frame.Set("height", Napi::Number::New(env, state_->height));
    frame.Set("timestampMicroseconds", Napi::Number::New(env, static_cast<double>(timestamp)));
    frame.Set("ntHandle", Napi::Buffer<uint8_t>::Copy(
      env,
      reinterpret_cast<const uint8_t*>(&slot->shared_handle),
      sizeof(slot->shared_handle)));
    return frame;
  }

  Napi::Value ReleaseFrame(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!state_ || info.Length() != 2 || !info[0].IsNumber() || !info[1].IsNumber()) return Napi::Boolean::New(env, false);
    const uint32_t slot_index = info[0].As<Napi::Number>().Uint32Value();
    const uint64_t sequence = static_cast<uint64_t>(info[1].As<Napi::Number>().Int64Value());
    if (slot_index >= state_->slots.size()) return Napi::Boolean::New(env, false);
    TextureSlot* slot = state_->slots[slot_index].get();
    if (!slot->electron_owned || slot->sequence != sequence) return Napi::Boolean::New(env, false);
    slot->electron_owned = false;
    return Napi::Boolean::New(env, true);
  }

  Napi::Value Resize(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!state_ || info.Length() != 2 || !info[0].IsNumber() || !info[1].IsNumber()) return Napi::Boolean::New(env, false);
    const double width_value = info[0].As<Napi::Number>().DoubleValue();
    const double height_value = info[1].As<Napi::Number>().DoubleValue();
    if (!std::isfinite(width_value) || !std::isfinite(height_value) ||
        std::floor(width_value) != width_value || std::floor(height_value) != height_value ||
        width_value < kMinimumDimension || width_value > kMaximumDimension ||
        height_value < kMinimumDimension || height_value > kMaximumDimension) {
      Napi::RangeError::New(env, "width/height must be integer values from 16 through 8192.").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    std::string error;
    if (!CreateTexturePool(state_.get(), static_cast<uint32_t>(width_value),
                           static_cast<uint32_t>(height_value), pool_size_, &error)) {
      return Napi::Boolean::New(env, false);
    }
    return Napi::Boolean::New(env, true);
  }

  Napi::Value GetStats(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Object stats = Napi::Object::New(env);
    stats.Set("producedFrames", Napi::Number::New(env, state_ ? static_cast<double>(state_->produced_frames) : 0));
    stats.Set("droppedFrames", Napi::Number::New(env, state_ ? static_cast<double>(state_->dropped_frames) : 0));
    stats.Set("outstandingFrames", Napi::Number::New(env, state_ ? static_cast<double>(state_->Outstanding()) : 0));
    stats.Set("poolSize", Napi::Number::New(env, state_ ? static_cast<double>(state_->slots.size()) : 0));
    stats.Set("unusable", Napi::Boolean::New(env, !state_ || state_->unusable));
    return stats;
  }

  Napi::Value Destroy(const Napi::CallbackInfo& info) {
    DestroyNative();
    return info.Env().Undefined();
  }

  void DestroyNative() {
    if (!state_) return;
    if (state_->Outstanding() != 0) {
      // Electron may still own the NT handles. Deliberately quarantine the
      // complete state until process exit instead of risking use-after-free.
      g_quarantined_states.fetch_add(1);
      static_cast<void>(state_.release());
      return;
    }
    state_.reset();
  }

  std::unique_ptr<ProducerState> state_;
  uint32_t pool_size_ = 0;
};

Napi::Object InitializeAddon(Napi::Env env, Napi::Object exports) {
  SyntheticTextureProducer::Initialize(env, exports);
  return InitializeLibMpvRuntimeProbe(env, exports);
}

}  // namespace

NODE_API_MODULE(seeing_stone_libmpv_bridge, InitializeAddon)
