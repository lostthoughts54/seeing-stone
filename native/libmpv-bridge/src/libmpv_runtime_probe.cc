#include "libmpv_runtime_probe.h"

#include <windows.h>

#include <d3d11.h>
#include <dxgi1_2.h>
#include <wrl/client.h>

#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <cwchar>
#include <limits>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

using Microsoft::WRL::ComPtr;

namespace {

struct mpv_handle;

using MpvClientApiVersion = uint64_t(__cdecl*)();
using MpvCreate = mpv_handle*(__cdecl*)();
using MpvInitialize = int(__cdecl*)(mpv_handle*);
using MpvTerminateDestroy = void(__cdecl*)(mpv_handle*);
using MpvSetOptionString = int(__cdecl*)(mpv_handle*, const char*, const char*);
using MpvCommand = int(__cdecl*)(mpv_handle*, const char* const*);

struct mpv_event {
  int event_id;
  int error;
  uint64_t reply_userdata;
  void* data;
};
struct mpv_event_log_message {
  const char* prefix;
  const char* level;
  const char* text;
  int log_level;
};

using MpvRequestLogMessages = int(__cdecl*)(mpv_handle*, const char*);
using MpvWaitEvent = mpv_event*(__cdecl*)(mpv_handle*, double);

constexpr int kMpvEventNone = 0;
constexpr int kMpvEventLogMessage = 2;
constexpr int kMpvEventStartFile = 6;
constexpr int kMpvEventEndFile = 7;
constexpr int kMpvEventFileLoaded = 8;
constexpr int kMpvEventTracksChanged = 9;
constexpr int kMpvEventVideoReconfig = 17;
constexpr int kMpvEventPlaybackRestart = 21;
constexpr int kMpvEventQueueOverflow = 24;

struct MpvDiagnosticEvent {
  std::string kind;
  std::string prefix;
  std::string level;
  std::string text;
  int error = 0;
};

struct mpv_node;
struct mpv_node_list {
  int num;
  mpv_node* values;
  char** keys;
};
struct mpv_byte_array {
  void* data;
  size_t size;
};
union mpv_node_union {
  char* string;
  int flag;
  int64_t int64;
  double double_value;
  mpv_node_list* list;
  mpv_byte_array* byte_array;
};
struct mpv_node {
  mpv_node_union value;
  int format;
};

using MpvGetProperty = int(__cdecl*)(mpv_handle*, const char*, int, void*);
using MpvFreeNodeContents = void(__cdecl*)(mpv_node*);

struct mpv_render_context;
struct mpv_render_param {
  int type;
  void* data;
};
struct mpv_opengl_init_params {
  void* (*get_proc_address)(void* context, const char* name);
  void* get_proc_address_ctx;
};
struct mpv_opengl_fbo {
  int fbo;
  int w;
  int h;
  int internal_format;
};

using MpvRenderContextCreate = int(__cdecl*)(mpv_render_context**, mpv_handle*, mpv_render_param*);
using MpvRenderContextFree = void(__cdecl*)(mpv_render_context*);
using MpvRenderContextRender = int(__cdecl*)(mpv_render_context*, mpv_render_param*);
using MpvRenderContextUpdate = uint64_t(__cdecl*)(mpv_render_context*);
using MpvRenderUpdateCallback = void(__cdecl*)(void*);
using MpvRenderContextSetUpdateCallback = void(__cdecl*)(mpv_render_context*, MpvRenderUpdateCallback, void*);

using EGLBoolean = unsigned int;
using EGLenum = unsigned int;
using EGLint = int;
using EGLAttrib = intptr_t;
using EGLDisplay = void*;
using EGLConfig = void*;
using EGLContext = void*;
using EGLSurface = void*;
using EGLDeviceEXT = void*;
using EGLClientBuffer = void*;

constexpr EGLBoolean EGL_FALSE_VALUE = 0;
constexpr EGLint EGL_NONE_VALUE = 0x3038;
constexpr EGLint EGL_EXTENSIONS_VALUE = 0x3055;
constexpr EGLint EGL_SURFACE_TYPE_VALUE = 0x3033;
constexpr EGLint EGL_PBUFFER_BIT_VALUE = 0x0001;
constexpr EGLint EGL_RENDERABLE_TYPE_VALUE = 0x3040;
constexpr EGLint EGL_OPENGL_ES2_BIT_VALUE = 0x0004;
constexpr EGLint EGL_RED_SIZE_VALUE = 0x3024;
constexpr EGLint EGL_GREEN_SIZE_VALUE = 0x3023;
constexpr EGLint EGL_BLUE_SIZE_VALUE = 0x3022;
constexpr EGLint EGL_ALPHA_SIZE_VALUE = 0x3021;
constexpr EGLint EGL_CONTEXT_CLIENT_VERSION_VALUE = 0x3098;
constexpr EGLenum EGL_OPENGL_ES_API_VALUE = 0x30A0;
constexpr EGLenum EGL_PLATFORM_ANGLE_ANGLE_VALUE = 0x3202;
constexpr EGLint EGL_PLATFORM_ANGLE_TYPE_ANGLE_VALUE = 0x3203;
constexpr EGLint EGL_PLATFORM_ANGLE_TYPE_D3D11_ANGLE_VALUE = 0x3208;
constexpr EGLint EGL_DEVICE_EXT_VALUE = 0x322C;
constexpr EGLint EGL_D3D11_DEVICE_ANGLE_VALUE = 0x33A1;
constexpr EGLenum EGL_D3D_TEXTURE_ANGLE_VALUE = 0x33A3;

using GLenum = unsigned int;
using GLint = int;
using GLsizei = int;
using GLvoid = void;

constexpr GLenum GL_RGBA_VALUE = 0x1908;
constexpr GLenum GL_UNSIGNED_BYTE_VALUE = 0x1401;

using EglGetProcAddress = void*(WINAPI*)(const char*);
using EglGetPlatformDisplayExt = EGLDisplay(WINAPI*)(EGLenum, void*, const EGLint*);
using EglInitialize = EGLBoolean(WINAPI*)(EGLDisplay, EGLint*, EGLint*);
using EglTerminate = EGLBoolean(WINAPI*)(EGLDisplay);
using EglBindApi = EGLBoolean(WINAPI*)(EGLenum);
using EglChooseConfig = EGLBoolean(WINAPI*)(EGLDisplay, const EGLint*, EGLConfig*, EGLint, EGLint*);
using EglCreateContext = EGLContext(WINAPI*)(EGLDisplay, EGLConfig, EGLContext, const EGLint*);
using EglDestroyContext = EGLBoolean(WINAPI*)(EGLDisplay, EGLContext);
using EglCreatePbufferFromClientBuffer = EGLSurface(WINAPI*)(EGLDisplay, EGLenum, EGLClientBuffer, EGLConfig, const EGLint*);
using EglDestroySurface = EGLBoolean(WINAPI*)(EGLDisplay, EGLSurface);
using EglMakeCurrent = EGLBoolean(WINAPI*)(EGLDisplay, EGLSurface, EGLSurface, EGLContext);
using EglQueryString = const char*(WINAPI*)(EGLDisplay, EGLint);
using EglQueryDisplayAttribExt = EGLBoolean(WINAPI*)(EGLDisplay, EGLint, EGLAttrib*);
using EglQueryDeviceAttribExt = EGLBoolean(WINAPI*)(EGLDeviceEXT, EGLint, EGLAttrib*);

constexpr uint32_t kMaximumSmokeIterations = 100;

std::wstring Utf8ToWide(const std::string& value) {
  if (value.empty()) return {};
  const int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                                         value.data(), static_cast<int>(value.size()),
                                         nullptr, 0);
  if (length <= 0) return {};
  std::wstring result(static_cast<size_t>(length), L'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                          static_cast<int>(value.size()), result.data(), length) != length) {
    return {};
  }
  return result;
}

bool IsAbsoluteDllPath(const std::wstring& value) {
  if (value.size() < 4 || value.find(L'\0') != std::wstring::npos) return false;
  if (_wcsicmp(value.c_str() + value.size() - 4, L".dll") != 0) return false;
  wchar_t resolved[MAX_PATH];
  const DWORD length = GetFullPathNameW(value.c_str(), MAX_PATH, resolved, nullptr);
  return length > 0 && length < MAX_PATH && _wcsicmp(value.c_str(), resolved) == 0;
}

bool IsAbsoluteDirectoryPath(const std::wstring& value) {
  if (value.empty() || value.find(L'\0') != std::wstring::npos) return false;
  wchar_t resolved[MAX_PATH];
  const DWORD length = GetFullPathNameW(value.c_str(), MAX_PATH, resolved, nullptr);
  if (length == 0 || length >= MAX_PATH) return false;
  std::wstring normalized(value);
  while (normalized.size() > 3 && (normalized.back() == L'\\' || normalized.back() == L'/')) normalized.pop_back();
  std::wstring normalized_resolved(resolved);
  while (normalized_resolved.size() > 3 && (normalized_resolved.back() == L'\\' || normalized_resolved.back() == L'/')) {
    normalized_resolved.pop_back();
  }
  return _wcsicmp(normalized.c_str(), normalized_resolved.c_str()) == 0;
}

bool IsAbsoluteFilePath(const std::wstring& value) {
  if (value.empty() || value.find(L'\0') != std::wstring::npos) return false;
  wchar_t resolved[MAX_PATH];
  const DWORD length = GetFullPathNameW(value.c_str(), MAX_PATH, resolved, nullptr);
  return length > 0 && length < MAX_PATH && _wcsicmp(value.c_str(), resolved) == 0;
}

class Module final {
 public:
  explicit Module(const std::wstring& absolute_path)
      : handle_(LoadLibraryExW(absolute_path.c_str(), nullptr,
                               LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR |
                               LOAD_LIBRARY_SEARCH_SYSTEM32)) {}

  ~Module() {
    if (handle_ != nullptr) FreeLibrary(handle_);
  }

  Module(const Module&) = delete;
  Module& operator=(const Module&) = delete;

  bool loaded() const { return handle_ != nullptr; }

  template <typename Function>
  Function Resolve(const char* name) const {
    return reinterpret_cast<Function>(GetProcAddress(handle_, name));
  }

 private:
  HMODULE handle_ = nullptr;
};

struct LibMpvFunctions {
  MpvClientApiVersion client_api_version = nullptr;
  MpvCreate create = nullptr;
  MpvInitialize initialize = nullptr;
  MpvTerminateDestroy terminate_destroy = nullptr;
  MpvSetOptionString set_option_string = nullptr;
  MpvCommand command = nullptr;
  MpvRequestLogMessages request_log_messages = nullptr;
  MpvWaitEvent wait_event = nullptr;
  MpvGetProperty get_property = nullptr;
  MpvFreeNodeContents free_node_contents = nullptr;
  MpvRenderContextCreate render_context_create = nullptr;
  MpvRenderContextFree render_context_free = nullptr;
  MpvRenderContextRender render_context_render = nullptr;
  MpvRenderContextUpdate render_context_update = nullptr;
  MpvRenderContextSetUpdateCallback render_context_set_update_callback = nullptr;

  bool Resolve(const Module& module) {
    client_api_version = module.Resolve<MpvClientApiVersion>("mpv_client_api_version");
    create = module.Resolve<MpvCreate>("mpv_create");
    initialize = module.Resolve<MpvInitialize>("mpv_initialize");
    terminate_destroy = module.Resolve<MpvTerminateDestroy>("mpv_terminate_destroy");
    set_option_string = module.Resolve<MpvSetOptionString>("mpv_set_option_string");
    command = module.Resolve<MpvCommand>("mpv_command");
    request_log_messages = module.Resolve<MpvRequestLogMessages>("mpv_request_log_messages");
    wait_event = module.Resolve<MpvWaitEvent>("mpv_wait_event");
    get_property = module.Resolve<MpvGetProperty>("mpv_get_property");
    free_node_contents = module.Resolve<MpvFreeNodeContents>("mpv_free_node_contents");
    render_context_create = module.Resolve<MpvRenderContextCreate>("mpv_render_context_create");
    render_context_free = module.Resolve<MpvRenderContextFree>("mpv_render_context_free");
    render_context_render = module.Resolve<MpvRenderContextRender>("mpv_render_context_render");
    render_context_update = module.Resolve<MpvRenderContextUpdate>("mpv_render_context_update");
    render_context_set_update_callback = module.Resolve<MpvRenderContextSetUpdateCallback>("mpv_render_context_set_update_callback");
    return client_api_version != nullptr && create != nullptr && initialize != nullptr &&
           terminate_destroy != nullptr &&
           set_option_string != nullptr && command != nullptr && get_property != nullptr &&
           free_node_contents != nullptr &&
           render_context_create != nullptr &&
           render_context_free != nullptr && render_context_render != nullptr &&
           render_context_update != nullptr && render_context_set_update_callback != nullptr;
  }
};

class MpvRenderContext final {
 public:
  explicit MpvRenderContext(const LibMpvFunctions& functions) : functions_(functions) {}
  ~MpvRenderContext() {
    if (context_ != nullptr) functions_.render_context_free(context_);
  }
  MpvRenderContext(const MpvRenderContext&) = delete;
  MpvRenderContext& operator=(const MpvRenderContext&) = delete;

  int Create(mpv_handle* handle, mpv_render_param* parameters) {
    return functions_.render_context_create(&context_, handle, parameters);
  }
  int Render(mpv_render_param* parameters) const {
    return functions_.render_context_render(context_, parameters);
  }
  uint64_t Update() const { return functions_.render_context_update(context_); }
  void SetUpdateCallback(MpvRenderUpdateCallback callback, void* context) const {
    functions_.render_context_set_update_callback(context_, callback, context);
  }

 private:
  const LibMpvFunctions& functions_;
  mpv_render_context* context_ = nullptr;
};

std::string Lowercase(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char character) {
    return static_cast<char>(std::tolower(character));
  });
  return value;
}

bool RelevantDiagnosticLog(const std::string& prefix, const std::string& level, const std::string& text) {
  const std::string normalized_level = Lowercase(level);
  if (normalized_level == "fatal" || normalized_level == "error" || normalized_level == "warn") return true;
  const std::string searchable = Lowercase(prefix + " " + text);
  for (const char* token : {
         "decoder", "decode", "hwdec", "hardware", "d3d11", "dxva", "nvdec", "cuda",
         "corrupt", "invalid", "interlac", "reconfig", "pixel format", "frame drop", "dropped frame",
       }) {
    if (searchable.find(token) != std::string::npos) return true;
  }
  return false;
}

std::string DiagnosticEventName(int event_id) {
  switch (event_id) {
    case kMpvEventStartFile: return "start-file";
    case kMpvEventEndFile: return "end-file";
    case kMpvEventFileLoaded: return "file-loaded";
    case kMpvEventTracksChanged: return "tracks-changed";
    case kMpvEventVideoReconfig: return "video-reconfig";
    case kMpvEventPlaybackRestart: return "playback-restart";
    case kMpvEventQueueOverflow: return "event-queue-overflow";
    default: return {};
  }
}

class MpvInstance final {
 public:
  explicit MpvInstance(const LibMpvFunctions& functions)
      : functions_(functions), handle_(functions_.create()) {}

  ~MpvInstance() {
    if (handle_ != nullptr) functions_.terminate_destroy(handle_);
  }

  MpvInstance(const MpvInstance&) = delete;
  MpvInstance& operator=(const MpvInstance&) = delete;

  bool created() const { return handle_ != nullptr; }
  int Initialize() const { return functions_.initialize(handle_); }
  mpv_handle* get() const { return handle_; }
  int SetOption(const char* name, const char* value) const {
    return functions_.set_option_string(handle_, name, value);
  }
  int Command(const char* const* arguments) const { return functions_.command(handle_, arguments); }
  bool EnableDiagnosticLogs() const {
    return functions_.request_log_messages != nullptr && functions_.wait_event != nullptr &&
           functions_.request_log_messages(handle_, "v") >= 0;
  }
  std::vector<MpvDiagnosticEvent> DrainDiagnosticEvents() const {
    std::vector<MpvDiagnosticEvent> result;
    if (functions_.wait_event == nullptr) return result;
    for (uint32_t index = 0; index < 512; ++index) {
      mpv_event* event = functions_.wait_event(handle_, 0);
      if (event == nullptr || event->event_id == kMpvEventNone) break;
      if (event->event_id == kMpvEventLogMessage && event->data != nullptr) {
        const auto* message = static_cast<const mpv_event_log_message*>(event->data);
        const std::string prefix = message->prefix == nullptr ? "" : message->prefix;
        const std::string level = message->level == nullptr ? "" : message->level;
        std::string text = message->text == nullptr ? "" : message->text;
        while (!text.empty() && (text.back() == '\r' || text.back() == '\n')) text.pop_back();
        if (RelevantDiagnosticLog(prefix, level, text)) {
          result.push_back({"mpv-log", prefix, level, text, event->error});
        }
        continue;
      }
      const std::string kind = DiagnosticEventName(event->event_id);
      if (!kind.empty()) result.push_back({kind, "", "", "", event->error});
    }
    return result;
  }
  int GetProperty(const char* name, mpv_node* value) const {
    constexpr int kMpvFormatNode = 6;
    return functions_.get_property(handle_, name, kMpvFormatNode, value);
  }
  void FreeNode(mpv_node* value) const { functions_.free_node_contents(value); }

 private:
  const LibMpvFunctions& functions_;
  mpv_handle* handle_ = nullptr;
};

bool HasExtension(const char* extensions, const char* expected) {
  if (extensions == nullptr || expected == nullptr || *expected == '\0' || std::strchr(expected, ' ') != nullptr) {
    return false;
  }
  const size_t length = std::strlen(expected);
  const char* position = extensions;
  while ((position = std::strstr(position, expected)) != nullptr) {
    const bool left_boundary = position == extensions || position[-1] == ' ';
    const bool right_boundary = position[length] == '\0' || position[length] == ' ';
    if (left_boundary && right_boundary) return true;
    position += length;
  }
  return false;
}

struct AngleTextureTarget {
  ComPtr<ID3D11Texture2D> texture;
  EGLSurface surface = nullptr;
  HANDLE shared_handle = nullptr;

  ~AngleTextureTarget() {
    if (shared_handle != nullptr) CloseHandle(shared_handle);
  }
  AngleTextureTarget() = default;
  AngleTextureTarget(const AngleTextureTarget&) = delete;
  AngleTextureTarget& operator=(const AngleTextureTarget&) = delete;
};

class AngleSharedTextureContext final {
 public:
  AngleSharedTextureContext(const std::wstring& egl_path, const std::wstring& gles_path)
      : egl_module_(std::make_unique<Module>(egl_path)),
        gles_module_(std::make_unique<Module>(gles_path)) {}

  ~AngleSharedTextureContext() {
    if (make_current_ != nullptr && display_ != nullptr) {
      make_current_(display_, nullptr, nullptr, nullptr);
    }
    if (destroy_surface_ != nullptr && display_ != nullptr) {
      for (const auto& target : targets_) {
        if (target->surface != nullptr) destroy_surface_(display_, target->surface);
      }
    }
    if (destroy_context_ != nullptr && display_ != nullptr && context_ != nullptr) {
      destroy_context_(display_, context_);
    }
    if (terminate_ != nullptr && display_ != nullptr) terminate_(display_);
  }

  AngleSharedTextureContext(const AngleSharedTextureContext&) = delete;
  AngleSharedTextureContext& operator=(const AngleSharedTextureContext&) = delete;

  const char* Initialize(uint32_t width = 64, uint32_t height = 64, uint32_t target_count = 1) {
    if (!egl_module_->loaded() || !gles_module_->loaded()) return "LIBMPV_ANGLE_SECURE_LOAD_FAILED";
    get_proc_address_ = egl_module_->Resolve<EglGetProcAddress>("eglGetProcAddress");
    initialize_ = egl_module_->Resolve<EglInitialize>("eglInitialize");
    terminate_ = egl_module_->Resolve<EglTerminate>("eglTerminate");
    bind_api_ = egl_module_->Resolve<EglBindApi>("eglBindAPI");
    choose_config_ = egl_module_->Resolve<EglChooseConfig>("eglChooseConfig");
    create_context_ = egl_module_->Resolve<EglCreateContext>("eglCreateContext");
    destroy_context_ = egl_module_->Resolve<EglDestroyContext>("eglDestroyContext");
    create_pbuffer_from_client_buffer_ = egl_module_->Resolve<EglCreatePbufferFromClientBuffer>("eglCreatePbufferFromClientBuffer");
    destroy_surface_ = egl_module_->Resolve<EglDestroySurface>("eglDestroySurface");
    make_current_ = egl_module_->Resolve<EglMakeCurrent>("eglMakeCurrent");
    query_string_ = egl_module_->Resolve<EglQueryString>("eglQueryString");
    if (get_proc_address_ == nullptr || initialize_ == nullptr || terminate_ == nullptr ||
        bind_api_ == nullptr || choose_config_ == nullptr || create_context_ == nullptr ||
        destroy_context_ == nullptr || create_pbuffer_from_client_buffer_ == nullptr ||
        destroy_surface_ == nullptr || make_current_ == nullptr || query_string_ == nullptr) {
      return "LIBMPV_ANGLE_REQUIRED_SYMBOL_MISSING";
    }

    const auto get_platform_display = reinterpret_cast<EglGetPlatformDisplayExt>(get_proc_address_("eglGetPlatformDisplayEXT"));
    query_display_attrib_ = reinterpret_cast<EglQueryDisplayAttribExt>(get_proc_address_("eglQueryDisplayAttribEXT"));
    query_device_attrib_ = reinterpret_cast<EglQueryDeviceAttribExt>(get_proc_address_("eglQueryDeviceAttribEXT"));
    if (get_platform_display == nullptr || query_display_attrib_ == nullptr || query_device_attrib_ == nullptr) {
      return "LIBMPV_ANGLE_EXTENSION_SYMBOL_MISSING";
    }

    const EGLint display_attributes[] = {
      EGL_PLATFORM_ANGLE_TYPE_ANGLE_VALUE, EGL_PLATFORM_ANGLE_TYPE_D3D11_ANGLE_VALUE,
      EGL_NONE_VALUE,
    };
    display_ = get_platform_display(EGL_PLATFORM_ANGLE_ANGLE_VALUE, nullptr, display_attributes);
    if (display_ == nullptr || initialize_(display_, &egl_major_, &egl_minor_) == EGL_FALSE_VALUE) {
      display_ = nullptr;
      return "LIBMPV_ANGLE_DISPLAY_INITIALIZE_FAILED";
    }
    const char* extensions = query_string_(display_, EGL_EXTENSIONS_VALUE);
    if (!HasExtension(extensions, "EGL_ANGLE_d3d_texture_client_buffer")) {
      return "LIBMPV_ANGLE_TEXTURE_EXTENSION_MISSING";
    }
    // Device-query and D3D11 capability are verified below by resolving and
    // successfully invoking their functions. ANGLE advertises those names on
    // the client/device extension strings rather than consistently repeating
    // them on the initialized display string.
    if (bind_api_(EGL_OPENGL_ES_API_VALUE) == EGL_FALSE_VALUE) return "LIBMPV_ANGLE_BIND_API_FAILED";

    const EGLint config_attributes[] = {
      EGL_SURFACE_TYPE_VALUE, EGL_PBUFFER_BIT_VALUE,
      EGL_RENDERABLE_TYPE_VALUE, EGL_OPENGL_ES2_BIT_VALUE,
      EGL_RED_SIZE_VALUE, 8,
      EGL_GREEN_SIZE_VALUE, 8,
      EGL_BLUE_SIZE_VALUE, 8,
      EGL_ALPHA_SIZE_VALUE, 8,
      EGL_NONE_VALUE,
    };
    EGLint config_count = 0;
    if (choose_config_(display_, config_attributes, &config_, 1, &config_count) == EGL_FALSE_VALUE || config_count != 1) {
      return "LIBMPV_ANGLE_CONFIG_UNAVAILABLE";
    }
    const EGLint context_attributes[] = {EGL_CONTEXT_CLIENT_VERSION_VALUE, 2, EGL_NONE_VALUE};
    context_ = create_context_(display_, config_, nullptr, context_attributes);
    if (context_ == nullptr) return "LIBMPV_ANGLE_CONTEXT_CREATE_FAILED";

    EGLAttrib egl_device_value = 0;
    EGLAttrib d3d_device_value = 0;
    if (query_display_attrib_(display_, EGL_DEVICE_EXT_VALUE, &egl_device_value) == EGL_FALSE_VALUE ||
        egl_device_value == 0 ||
        query_device_attrib_(reinterpret_cast<EGLDeviceEXT>(egl_device_value), EGL_D3D11_DEVICE_ANGLE_VALUE,
                             &d3d_device_value) == EGL_FALSE_VALUE || d3d_device_value == 0) {
      return "LIBMPV_ANGLE_D3D11_DEVICE_QUERY_FAILED";
    }
    d3d_device_ = reinterpret_cast<ID3D11Device*>(d3d_device_value);

    for (uint32_t index = 0; index < target_count; ++index) {
      if (const char* target_error = CreateTarget(width, height); target_error != nullptr) return target_error;
    }
    if (!MakeCurrent(0)) return "LIBMPV_ANGLE_MAKE_CURRENT_FAILED";
    return nullptr;
  }

  bool MakeCurrent(size_t index) const {
    if (index >= targets_.size()) return false;
    return make_current_(display_, targets_[index]->surface, targets_[index]->surface, context_) != EGL_FALSE_VALUE;
  }

  void ClearCurrent() const {
    make_current_(display_, nullptr, nullptr, nullptr);
  }

  HANDLE shared_handle(size_t index) const {
    return index < targets_.size() ? targets_[index]->shared_handle : nullptr;
  }

  size_t target_count() const { return targets_.size(); }

  bool Finish() const {
    using GlFinish = void(WINAPI*)();
    const auto finish = reinterpret_cast<GlFinish>(GetGlProcAddress("glFinish"));
    if (finish == nullptr) return false;
    finish();
    return true;
  }

  bool ReadPixelsRgba(uint32_t width, uint32_t height, std::vector<uint8_t>* output) const {
    using GlReadPixels = void(WINAPI*)(GLint, GLint, GLsizei, GLsizei, GLenum, GLenum, GLvoid*);
    const auto read_pixels = reinterpret_cast<GlReadPixels>(GetGlProcAddress("glReadPixels"));
    if (read_pixels == nullptr || output == nullptr) return false;
    const uint64_t byte_count = static_cast<uint64_t>(width) * static_cast<uint64_t>(height) * 4;
    if (byte_count > static_cast<uint64_t>(std::numeric_limits<size_t>::max())) return false;
    output->assign(static_cast<size_t>(byte_count), 0);
    read_pixels(0, 0, static_cast<GLsizei>(width), static_cast<GLsizei>(height),
                GL_RGBA_VALUE, GL_UNSIGNED_BYTE_VALUE, output->data());
    return true;
  }

  void* GetGlProcAddress(const char* name) const {
    void* result = get_proc_address_ != nullptr ? get_proc_address_(name) : nullptr;
    return result != nullptr ? result : reinterpret_cast<void*>(gles_module_->Resolve<FARPROC>(name));
  }

  static void* GetGlProcAddressCallback(void* context, const char* name) {
    return static_cast<AngleSharedTextureContext*>(context)->GetGlProcAddress(name);
  }

  int egl_major() const { return egl_major_; }
  int egl_minor() const { return egl_minor_; }

 private:
  const char* CreateTarget(uint32_t width, uint32_t height) {
    auto target = std::make_unique<AngleTextureTarget>();
    D3D11_TEXTURE2D_DESC description{};
    description.Width = width;
    description.Height = height;
    description.MipLevels = 1;
    description.ArraySize = 1;
    description.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    description.SampleDesc.Count = 1;
    description.Usage = D3D11_USAGE_DEFAULT;
    description.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
    description.MiscFlags = D3D11_RESOURCE_MISC_SHARED_NTHANDLE | D3D11_RESOURCE_MISC_SHARED;
    if (FAILED(d3d_device_->CreateTexture2D(&description, nullptr, &target->texture))) {
      return "LIBMPV_ANGLE_TEXTURE_CREATE_FAILED";
    }
    ComPtr<IDXGIResource1> shared_resource;
    if (FAILED(target->texture.As(&shared_resource)) ||
        FAILED(shared_resource->CreateSharedHandle(nullptr,
          DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE, nullptr, &target->shared_handle))) {
      return "LIBMPV_ANGLE_SHARED_HANDLE_CREATE_FAILED";
    }
    const EGLint surface_attributes[] = {EGL_NONE_VALUE};
    target->surface = create_pbuffer_from_client_buffer_(display_, EGL_D3D_TEXTURE_ANGLE_VALUE,
      reinterpret_cast<EGLClientBuffer>(target->texture.Get()), config_, surface_attributes);
    if (target->surface == nullptr) return "LIBMPV_ANGLE_TEXTURE_IMPORT_FAILED";
    targets_.push_back(std::move(target));
    return nullptr;
  }
  std::unique_ptr<Module> egl_module_;
  std::unique_ptr<Module> gles_module_;
  EglGetProcAddress get_proc_address_ = nullptr;
  EglInitialize initialize_ = nullptr;
  EglTerminate terminate_ = nullptr;
  EglBindApi bind_api_ = nullptr;
  EglChooseConfig choose_config_ = nullptr;
  EglCreateContext create_context_ = nullptr;
  EglDestroyContext destroy_context_ = nullptr;
  EglCreatePbufferFromClientBuffer create_pbuffer_from_client_buffer_ = nullptr;
  EglDestroySurface destroy_surface_ = nullptr;
  EglMakeCurrent make_current_ = nullptr;
  EglQueryString query_string_ = nullptr;
  EglQueryDisplayAttribExt query_display_attrib_ = nullptr;
  EglQueryDeviceAttribExt query_device_attrib_ = nullptr;
  EGLDisplay display_ = nullptr;
  EGLConfig config_ = nullptr;
  EGLContext context_ = nullptr;
  ID3D11Device* d3d_device_ = nullptr;
  std::vector<std::unique_ptr<AngleTextureTarget>> targets_;
  EGLint egl_major_ = 0;
  EGLint egl_minor_ = 0;
};

struct VideoFrameSlot {
  uint64_t sequence = 0;
  int64_t timestamp_microseconds = 0;
  double readback_milliseconds = 0;
  bool ready = false;
  bool electron_owned = false;
  std::vector<uint8_t> cpu_pixels_rgba;
};

struct LibMpvVideoState {
  std::unique_ptr<Module> library;
  LibMpvFunctions functions;
  std::unique_ptr<AngleSharedTextureContext> angle;
  std::unique_ptr<MpvInstance> instance;
  std::unique_ptr<MpvRenderContext> render_context;
  std::vector<VideoFrameSlot> slots;
  std::atomic<bool> render_requested{true};
  std::atomic<bool> stopping{false};
  std::atomic<bool> suspended{false};
  std::thread render_thread;
  mutable std::mutex mutex;
  std::condition_variable wake;
  uint32_t width = 0;
  uint32_t height = 0;
  uint64_t next_sequence = 1;
  uint64_t rendered_frames = 0;
  uint64_t dropped_frames = 0;
  uint64_t readback_frames = 0;
  uint64_t readback_failures = 0;
  bool waiting_for_slot = false;
  bool rendering = false;
  bool cpu_readback = false;
  std::atomic<bool> unusable{false};

  ~LibMpvVideoState() {
    StopRenderThread();
    render_context.reset();
    instance.reset();
    angle.reset();
    library.reset();
  }

  size_t Outstanding() const {
    std::lock_guard<std::mutex> lock(mutex);
    size_t count = 0;
    for (const auto& slot : slots) {
      if (slot.electron_owned) ++count;
    }
    return count;
  }

  void StartRenderThread() {
    angle->ClearCurrent();
    render_thread = std::thread([this]() { RenderLoop(); });
  }

  void StopRenderThread() {
    stopping.store(true);
    wake.notify_all();
    if (render_thread.joinable()) render_thread.join();
    else if (render_context) render_context->SetUpdateCallback(nullptr, nullptr);
  }

  void RenderLoop() {
    while (!stopping.load()) {
      {
        std::unique_lock<std::mutex> lock(mutex);
        wake.wait_for(lock, std::chrono::milliseconds(16), [this]() {
          return stopping.load() || (!suspended.load() && render_requested.load());
        });
      }
      if (stopping.load()) break;
      if (suspended.load()) continue;
      const uint64_t update_flags = render_context->Update();
      if ((update_flags & 1) == 0 && !render_requested.exchange(false)) continue;
      render_requested.store(false);
      size_t slot_index = slots.size();
      {
        std::lock_guard<std::mutex> lock(mutex);
        if (suspended.load()) continue;
        for (size_t index = 0; index < slots.size(); ++index) {
          if (!slots[index].electron_owned && !slots[index].ready) {
            slot_index = index;
            break;
          }
        }
        if (slot_index == slots.size()) {
          ++dropped_frames;
          waiting_for_slot = true;
          render_requested.store(false);
        } else {
          waiting_for_slot = false;
          rendering = true;
        }
      }
      if (slot_index == slots.size()) {
        std::unique_lock<std::mutex> lock(mutex);
        wake.wait_for(lock, std::chrono::milliseconds(16), [this]() {
          if (stopping.load()) return true;
          for (const auto& slot : slots) if (!slot.electron_owned && !slot.ready) return true;
          return false;
        });
        render_requested.store(true);
        continue;
      }
      if (!angle->MakeCurrent(slot_index)) {
        unusable.store(true);
        {
          std::lock_guard<std::mutex> lock(mutex);
          rendering = false;
        }
        wake.notify_all();
        break;
      }
      mpv_opengl_fbo framebuffer{0, static_cast<int>(width), static_cast<int>(height), 0};
      int flip_y = 1;
      mpv_render_param parameters[] = {
        {3, &framebuffer},
        {4, &flip_y},
        {0, nullptr},
      };
      if (render_context->Render(parameters) < 0 || !angle->Finish()) {
        unusable.store(true);
        {
          std::lock_guard<std::mutex> lock(mutex);
          rendering = false;
        }
        wake.notify_all();
        break;
      }
      std::vector<uint8_t> readback_pixels;
      double readback_milliseconds = 0;
      bool readback_succeeded = true;
      if (cpu_readback) {
        const auto readback_started = std::chrono::steady_clock::now();
        readback_succeeded = angle->ReadPixelsRgba(width, height, &readback_pixels);
        const auto readback_finished = std::chrono::steady_clock::now();
        readback_milliseconds = std::chrono::duration<double, std::milli>(
          readback_finished - readback_started).count();
        angle->Finish();
      }
      const int64_t timestamp = std::chrono::duration_cast<std::chrono::microseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
      {
        std::lock_guard<std::mutex> lock(mutex);
        VideoFrameSlot& slot = slots[slot_index];
        if (cpu_readback && !readback_succeeded) {
          ++readback_failures;
          ++dropped_frames;
          rendering = false;
          wake.notify_all();
          continue;
        }
        slot.sequence = next_sequence++;
        slot.timestamp_microseconds = timestamp;
        slot.readback_milliseconds = readback_milliseconds;
        slot.cpu_pixels_rgba = std::move(readback_pixels);
        slot.ready = true;
        ++rendered_frames;
        if (cpu_readback) ++readback_frames;
        rendering = false;
      }
      wake.notify_all();
    }
    if (render_context) {
      angle->MakeCurrent(0);
      render_context->SetUpdateCallback(nullptr, nullptr);
      render_context.reset();
    }
    angle->ClearCurrent();
  }
};

std::vector<LibMpvVideoState*> g_quarantined_video_states;

void __cdecl LibMpvRenderUpdate(void* context) {
  if (context == nullptr) return;
  LibMpvVideoState* state = static_cast<LibMpvVideoState*>(context);
  state->render_requested.store(true);
  state->wake.notify_one();
}

class LibMpvVideoProducer final : public Napi::ObjectWrap<LibMpvVideoProducer> {
 public:
  static Napi::Object Initialize(Napi::Env env, Napi::Object exports) {
    Napi::Function constructor = DefineClass(env, "LibMpvVideoProducer", {
      InstanceMethod("nextFrame", &LibMpvVideoProducer::NextFrame),
      InstanceMethod("releaseFrame", &LibMpvVideoProducer::ReleaseFrame),
      InstanceMethod("command", &LibMpvVideoProducer::Command),
      InstanceMethod("getProperty", &LibMpvVideoProducer::GetProperty),
      InstanceMethod("drainDiagnostics", &LibMpvVideoProducer::DrainDiagnostics),
      InstanceMethod("setSuspended", &LibMpvVideoProducer::SetSuspended),
      InstanceMethod("getStats", &LibMpvVideoProducer::GetStats),
      InstanceMethod("destroy", &LibMpvVideoProducer::Destroy),
    });
    exports.Set("LibMpvVideoProducer", constructor);
    return exports;
  }

  explicit LibMpvVideoProducer(const Napi::CallbackInfo& info)
      : Napi::ObjectWrap<LibMpvVideoProducer>(info), state_(std::make_unique<LibMpvVideoState>()) {
    Napi::Env env = info.Env();
    if (info.Length() != 1 || !info[0].IsObject()) {
      Fail(env, "LibMpvVideoProducer requires one options object.");
      return;
    }
    const Napi::Object options = info[0].As<Napi::Object>();
    const Napi::Value library_value = options.Get("libraryPath");
    const Napi::Value angle_value = options.Get("angleDirectory");
    const Napi::Value source_value = options.Get("sourcePath");
    if (!library_value.IsString() || !angle_value.IsString() || !source_value.IsString() ||
        !ReadUint32(options, "width", 16, 8192, &state_->width) ||
        !ReadUint32(options, "height", 16, 8192, &state_->height)) {
      Fail(env, "Controlled library, ANGLE, source, width, and height options are required.");
      return;
    }
    uint32_t pool_size = 0;
    if (!ReadUint32(options, "poolSize", 2, 8, &pool_size)) {
      Fail(env, "poolSize must be from 2 through 8.");
      return;
    }
    const std::string library_utf8 = library_value.As<Napi::String>().Utf8Value();
    const std::string angle_utf8 = angle_value.As<Napi::String>().Utf8Value();
    const std::string source_utf8 = source_value.As<Napi::String>().Utf8Value();
    const std::wstring library_path = Utf8ToWide(library_utf8);
    std::wstring angle_directory = Utf8ToWide(angle_utf8);
    const std::wstring source_path = Utf8ToWide(source_utf8);
    const bool loop = !options.Has("loop") || options.Get("loop").ToBoolean().Value();
    const bool audio_enabled = options.Has("audioEnabled") && options.Get("audioEnabled").ToBoolean().Value();
    if (options.Has("cpuReadback") && !options.Get("cpuReadback").IsBoolean()) {
      Fail(env, "cpuReadback must be a boolean.");
      return;
    }
    state_->cpu_readback = options.Has("cpuReadback") && options.Get("cpuReadback").ToBoolean().Value();
    std::string hardware_decoding_mode = options.Has("hardwareDecoding") && options.Get("hardwareDecoding").ToBoolean().Value()
      ? "auto-safe"
      : "no";
    if (options.Has("hardwareDecodingMode")) {
      const Napi::Value mode_value = options.Get("hardwareDecodingMode");
      if (!mode_value.IsString()) {
        Fail(env, "hardwareDecodingMode must be current, software, or auto-copy.");
        return;
      }
      const std::string requested_mode = mode_value.As<Napi::String>().Utf8Value();
      hardware_decoding_mode = requested_mode == "current" ? "auto-safe"
        : requested_mode == "software" ? "no"
        : requested_mode == "auto-copy" ? "auto-copy"
        : "";
      if (hardware_decoding_mode.empty()) {
        Fail(env, "hardwareDecodingMode must be current, software, or auto-copy.");
        return;
      }
    }
    const bool diagnostic_logging = options.Has("diagnosticLogging") && options.Get("diagnosticLogging").ToBoolean().Value();
    double start_position_seconds = 0;
    if (options.Has("startPositionSeconds")) {
      const Napi::Value start_value = options.Get("startPositionSeconds");
      if (!start_value.IsNumber() || !std::isfinite(start_value.As<Napi::Number>().DoubleValue()) ||
          start_value.As<Napi::Number>().DoubleValue() < 0) {
        Fail(env, "startPositionSeconds must be a non-negative number.");
        return;
      }
      start_position_seconds = start_value.As<Napi::Number>().DoubleValue();
    }
    const bool controlled_loopback = source_utf8.rfind("http://127.0.0.1:", 0) == 0 ||
                                     source_utf8.rfind("http://[::1]:", 0) == 0;
    if (!IsAbsoluteDllPath(library_path) || !IsAbsoluteDirectoryPath(angle_directory) ||
        (!controlled_loopback && !IsAbsoluteFilePath(source_path))) {
      Fail(env, "Native video inputs must use absolute controlled paths.");
      return;
    }
    while (!angle_directory.empty() && (angle_directory.back() == L'\\' || angle_directory.back() == L'/')) {
      angle_directory.pop_back();
    }

    state_->library = std::make_unique<Module>(library_path);
    if (!state_->library->loaded() || !state_->functions.Resolve(*state_->library)) {
      Fail(env, "LIBMPV_VIDEO_SECURE_LOAD_FAILED");
      return;
    }
    state_->angle = std::make_unique<AngleSharedTextureContext>(
      angle_directory + L"\\libEGL.dll", angle_directory + L"\\libGLESv2.dll");
    if (const char* angle_error = state_->angle->Initialize(state_->width, state_->height, pool_size);
        angle_error != nullptr) {
      Fail(env, angle_error);
      return;
    }
    state_->slots.resize(pool_size);
    state_->instance = std::make_unique<MpvInstance>(state_->functions);
    const std::string start_option = std::to_string(start_position_seconds);
    if (!state_->instance->created() ||
        state_->instance->SetOption("config", "no") < 0 ||
        state_->instance->SetOption("load-scripts", "no") < 0 ||
        state_->instance->SetOption("vo", "libmpv") < 0 ||
        state_->instance->SetOption("terminal", "no") < 0 ||
        (!audio_enabled && state_->instance->SetOption("ao", "null") < 0) ||
        state_->instance->SetOption("hwdec", hardware_decoding_mode.c_str()) < 0 ||
        state_->instance->SetOption("loop-file", loop ? "inf" : "no") < 0 ||
        state_->instance->SetOption("keep-open", "yes") < 0 ||
        (start_position_seconds > 0 && state_->instance->SetOption("start", start_option.c_str()) < 0) ||
        state_->instance->Initialize() < 0) {
      Fail(env, "LIBMPV_VIDEO_INITIALIZE_FAILED");
      return;
    }
    if (diagnostic_logging) state_->instance->EnableDiagnosticLogs();
    mpv_opengl_init_params init_parameters{
      AngleSharedTextureContext::GetGlProcAddressCallback,
      state_->angle.get(),
    };
    const char* api_type = "opengl";
    mpv_render_param render_parameters[] = {
      {1, const_cast<char*>(api_type)},
      {2, &init_parameters},
      {0, nullptr},
    };
    state_->render_context = std::make_unique<MpvRenderContext>(state_->functions);
    if (state_->render_context->Create(state_->instance->get(), render_parameters) < 0) {
      Fail(env, "LIBMPV_VIDEO_RENDER_CONTEXT_FAILED");
      return;
    }
    state_->render_context->SetUpdateCallback(LibMpvRenderUpdate, state_.get());
    const char* command[] = {"loadfile", source_utf8.c_str(), "replace", nullptr};
    if (state_->instance->Command(command) < 0) {
      Fail(env, "LIBMPV_VIDEO_LOAD_FAILED");
      return;
    }
    state_->StartRenderThread();
  }

  ~LibMpvVideoProducer() override { DestroyNative(); }

 private:
  static bool ReadUint32(const Napi::Object& options, const char* key, uint32_t minimum,
                         uint32_t maximum, uint32_t* output) {
    const Napi::Value value = options.Get(key);
    if (!value.IsNumber()) return false;
    const double number = value.As<Napi::Number>().DoubleValue();
    if (number < minimum || number > maximum || number != static_cast<uint32_t>(number)) return false;
    *output = static_cast<uint32_t>(number);
    return true;
  }

  void Fail(Napi::Env env, const char* message) {
    state_.reset();
    Napi::Error::New(env, message).ThrowAsJavaScriptException();
  }

  Napi::Value NextFrame(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!state_ || state_->unusable) {
      Napi::Error::New(env, "LIBMPV_VIDEO_PRODUCER_UNAVAILABLE").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    size_t slot_index = state_->slots.size();
    uint64_t sequence = 0;
    int64_t timestamp = 0;
    double readback_milliseconds = 0;
    std::vector<uint8_t> cpu_pixels_rgba;
    {
      std::lock_guard<std::mutex> lock(state_->mutex);
      for (size_t index = 0; index < state_->slots.size(); ++index) {
        if (state_->slots[index].ready && !state_->slots[index].electron_owned &&
            (slot_index == state_->slots.size() || state_->slots[index].sequence < sequence)) {
          slot_index = index;
          sequence = state_->slots[index].sequence;
        }
      }
      if (slot_index == state_->slots.size()) return env.Null();
      VideoFrameSlot& slot = state_->slots[slot_index];
      slot.ready = false;
      slot.electron_owned = true;
      sequence = slot.sequence;
      timestamp = slot.timestamp_microseconds;
      readback_milliseconds = slot.readback_milliseconds;
      if (state_->cpu_readback) cpu_pixels_rgba = slot.cpu_pixels_rgba;
    }
    HANDLE handle = state_->angle->shared_handle(slot_index);
    Napi::Object frame = Napi::Object::New(env);
    frame.Set("slot", Napi::Number::New(env, static_cast<double>(slot_index)));
    frame.Set("sequence", Napi::Number::New(env, static_cast<double>(sequence)));
    frame.Set("width", Napi::Number::New(env, state_->width));
    frame.Set("height", Napi::Number::New(env, state_->height));
    frame.Set("timestampMicroseconds", Napi::Number::New(env, static_cast<double>(timestamp)));
    if (state_->cpu_readback) {
      frame.Set("pixelFormat", "rgba");
      frame.Set("readbackMilliseconds", Napi::Number::New(env, readback_milliseconds));
      frame.Set("pixels", Napi::Buffer<uint8_t>::Copy(env, cpu_pixels_rgba.data(), cpu_pixels_rgba.size()));
    } else {
      frame.Set("ntHandle", Napi::Buffer<uint8_t>::Copy(env,
        reinterpret_cast<const uint8_t*>(&handle), sizeof(handle)));
    }
    return frame;
  }

  Napi::Value ReleaseFrame(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!state_ || info.Length() != 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
      return Napi::Boolean::New(env, false);
    }
    const uint32_t index = info[0].As<Napi::Number>().Uint32Value();
    const uint64_t sequence = static_cast<uint64_t>(info[1].As<Napi::Number>().Int64Value());
    if (index >= state_->slots.size()) return Napi::Boolean::New(env, false);
    std::lock_guard<std::mutex> lock(state_->mutex);
    VideoFrameSlot& slot = state_->slots[index];
    if (!slot.electron_owned || slot.sequence != sequence) return Napi::Boolean::New(env, false);
    slot.electron_owned = false;
    slot.cpu_pixels_rgba.clear();
    if (state_->waiting_for_slot) state_->render_requested.store(true);
    state_->wake.notify_one();
    return Napi::Boolean::New(env, true);
  }

  static Napi::Value NodeToValue(Napi::Env env, const mpv_node& node, uint32_t depth = 0) {
    if (depth > 16) return env.Null();
    switch (node.format) {
      case 0: return env.Null();
      case 1:
      case 2: return Napi::String::New(env, node.value.string == nullptr ? "" : node.value.string);
      case 3: return Napi::Boolean::New(env, node.value.flag != 0);
      case 4: return Napi::Number::New(env, static_cast<double>(node.value.int64));
      case 5: return Napi::Number::New(env, node.value.double_value);
      case 7: {
        Napi::Array result = Napi::Array::New(env);
        if (node.value.list == nullptr) return result;
        for (int index = 0; index < node.value.list->num; ++index) {
          result.Set(static_cast<uint32_t>(index), NodeToValue(env, node.value.list->values[index], depth + 1));
        }
        return result;
      }
      case 8: {
        Napi::Object result = Napi::Object::New(env);
        if (node.value.list == nullptr) return result;
        for (int index = 0; index < node.value.list->num; ++index) {
          const char* key = node.value.list->keys == nullptr ? nullptr : node.value.list->keys[index];
          if (key != nullptr) result.Set(key, NodeToValue(env, node.value.list->values[index], depth + 1));
        }
        return result;
      }
      default: return env.Null();
    }
  }

  Napi::Value Command(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!state_ || state_->unusable || info.Length() != 1 || !info[0].IsArray()) {
      Napi::TypeError::New(env, "command requires an array of strings.").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    const Napi::Array input = info[0].As<Napi::Array>();
    if (input.Length() == 0 || input.Length() > 32) {
      Napi::RangeError::New(env, "command must contain from 1 through 32 values.").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    std::vector<std::string> values;
    values.reserve(input.Length());
    for (uint32_t index = 0; index < input.Length(); ++index) {
      const Napi::Value value = input.Get(index);
      if (!value.IsString()) {
        Napi::TypeError::New(env, "command values must be strings.").ThrowAsJavaScriptException();
        return env.Undefined();
      }
      values.push_back(value.As<Napi::String>().Utf8Value());
    }
    std::vector<const char*> arguments;
    arguments.reserve(values.size() + 1);
    for (const std::string& value : values) arguments.push_back(value.c_str());
    arguments.push_back(nullptr);
    if (state_->instance->Command(arguments.data()) < 0) {
      Napi::Error::New(env, "LIBMPV_COMMAND_FAILED").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    return env.Undefined();
  }

  Napi::Value GetProperty(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!state_ || state_->unusable || info.Length() != 1 || !info[0].IsString()) {
      Napi::TypeError::New(env, "getProperty requires one property name.").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    const std::string name = info[0].As<Napi::String>().Utf8Value();
    if (name.empty() || name.size() > 128) return env.Null();
    mpv_node node{};
    if (state_->instance->GetProperty(name.c_str(), &node) < 0) return env.Null();
    Napi::Value result = NodeToValue(env, node);
    state_->instance->FreeNode(&node);
    return result;
  }

  Napi::Value DrainDiagnostics(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Array result = Napi::Array::New(env);
    if (!state_ || state_->unusable) return result;
    const std::vector<MpvDiagnosticEvent> events = state_->instance->DrainDiagnosticEvents();
    for (uint32_t index = 0; index < events.size(); ++index) {
      const MpvDiagnosticEvent& event = events[index];
      Napi::Object value = Napi::Object::New(env);
      value.Set("kind", event.kind);
      if (!event.prefix.empty()) value.Set("prefix", event.prefix);
      if (!event.level.empty()) value.Set("level", event.level);
      if (!event.text.empty()) value.Set("text", event.text);
      if (event.error != 0) value.Set("error", event.error);
      result.Set(index, value);
    }
    return result;
  }

  Napi::Value SetSuspended(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!state_ || info.Length() != 1 || !info[0].IsBoolean()) {
      Napi::TypeError::New(env, "setSuspended requires one boolean.").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    const bool suspended = info[0].As<Napi::Boolean>().Value();
    state_->suspended.store(suspended);
    if (suspended) {
      std::unique_lock<std::mutex> lock(state_->mutex);
      state_->wake.wait(lock, [this]() { return !state_ || !state_->rendering; });
    } else {
      state_->render_requested.store(true);
      state_->wake.notify_one();
    }
    return env.Undefined();
  }

  Napi::Value GetStats(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Object stats = Napi::Object::New(env);
    uint64_t rendered = 0;
    uint64_t dropped = 0;
    uint64_t readback = 0;
    uint64_t readback_failures = 0;
    size_t outstanding = 0;
    size_t pool_size = 0;
    bool unusable = true;
    if (state_) {
      std::lock_guard<std::mutex> lock(state_->mutex);
      rendered = state_->rendered_frames;
      dropped = state_->dropped_frames;
      readback = state_->readback_frames;
      readback_failures = state_->readback_failures;
      pool_size = state_->slots.size();
      for (const auto& slot : state_->slots) if (slot.electron_owned) ++outstanding;
      unusable = state_->unusable.load();
    }
    stats.Set("renderedFrames", Napi::Number::New(env, static_cast<double>(rendered)));
    stats.Set("droppedFrames", Napi::Number::New(env, static_cast<double>(dropped)));
    stats.Set("readbackFrames", Napi::Number::New(env, static_cast<double>(readback)));
    stats.Set("readbackFailures", Napi::Number::New(env, static_cast<double>(readback_failures)));
    stats.Set("outstandingFrames", Napi::Number::New(env, static_cast<double>(outstanding)));
    stats.Set("poolSize", Napi::Number::New(env, static_cast<double>(pool_size)));
    stats.Set("unusable", Napi::Boolean::New(env, unusable));
    return stats;
  }

  Napi::Value Destroy(const Napi::CallbackInfo& info) {
    DestroyNative();
    return info.Env().Undefined();
  }

  void DestroyNative() {
    if (!state_) return;
    state_->StopRenderThread();
    if (state_->Outstanding() != 0) {
      g_quarantined_video_states.push_back(state_.release());
      return;
    }
    state_.reset();
  }

  std::unique_ptr<LibMpvVideoState> state_;
};

bool ParseApiVersion(const std::string& value, uint64_t* output) {
  const size_t separator = value.find('.');
  if (separator == std::string::npos || separator == 0 || separator == value.size() - 1) return false;
  uint64_t major = 0;
  uint64_t minor = 0;
  for (size_t index = 0; index < value.size(); ++index) {
    if (index == separator) continue;
    const char character = value[index];
    if (character < '0' || character > '9') return false;
    uint64_t& part = index < separator ? major : minor;
    part = part * 10 + static_cast<uint64_t>(character - '0');
    if (part > 0xffff) return false;
  }
  *output = (major << 16) | minor;
  return true;
}

std::string FormatApiVersion(uint64_t version) {
  return std::to_string((version >> 16) & 0xffff) + "." +
         std::to_string(version & 0xffff);
}

Napi::Value ProbeLibMpvRuntime(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() != 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env, "probeLibMpvRuntime requires one options object.")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const Napi::Object options = info[0].As<Napi::Object>();
  const Napi::Value library_value = options.Get("libraryPath");
  const Napi::Value version_value = options.Get("expectedClientApiVersion");
  const Napi::Value iterations_value = options.Get("iterations");
  if (!library_value.IsString() || !version_value.IsString() || !iterations_value.IsNumber()) {
    Napi::TypeError::New(env, "libraryPath, expectedClientApiVersion, and iterations are required.")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const std::wstring library_path = Utf8ToWide(library_value.As<Napi::String>().Utf8Value());
  const uint32_t iterations = iterations_value.As<Napi::Number>().Uint32Value();
  uint64_t expected_version = 0;
  if (!IsAbsoluteDllPath(library_path)) {
    Napi::RangeError::New(env, "The libmpv library path must be an absolute DLL path.")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (iterations == 0 || iterations > kMaximumSmokeIterations) {
    Napi::RangeError::New(env, "iterations must be from 1 through 100.")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (!ParseApiVersion(version_value.As<Napi::String>().Utf8Value(), &expected_version)) {
    Napi::RangeError::New(env, "expectedClientApiVersion must be a major.minor value.")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  Module module(library_path);
  if (!module.loaded()) {
    Napi::Error::New(env, "LIBMPV_SECURE_LOAD_FAILED").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  LibMpvFunctions functions;
  if (!functions.Resolve(module)) {
    Napi::Error::New(env, "LIBMPV_REQUIRED_SYMBOL_MISSING").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const uint64_t actual_version = functions.client_api_version();
  if (actual_version != expected_version) {
    Napi::Error::New(env, "LIBMPV_CLIENT_ABI_MISMATCH").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  for (uint32_t iteration = 0; iteration < iterations; ++iteration) {
    MpvInstance instance(functions);
    if (!instance.created()) {
      Napi::Error::New(env, "LIBMPV_CREATE_FAILED").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    if (instance.Initialize() < 0) {
      Napi::Error::New(env, "LIBMPV_INITIALIZE_FAILED").ThrowAsJavaScriptException();
      return env.Undefined();
    }
  }

  Napi::Object result = Napi::Object::New(env);
  result.Set("clientApiVersion", FormatApiVersion(actual_version));
  result.Set("completedIterations", Napi::Number::New(env, iterations));
  result.Set("secureAbsoluteLoad", Napi::Boolean::New(env, true));
  result.Set("requiredRenderSymbolsPresent", Napi::Boolean::New(env, true));
  return result;
}

Napi::Value ProbeLibMpvRenderContext(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() != 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env, "probeLibMpvRenderContext requires one options object.")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const Napi::Object options = info[0].As<Napi::Object>();
  const Napi::Value library_value = options.Get("libraryPath");
  const Napi::Value angle_value = options.Get("angleDirectory");
  const Napi::Value version_value = options.Get("expectedClientApiVersion");
  const Napi::Value iterations_value = options.Get("iterations");
  if (!library_value.IsString() || !angle_value.IsString() || !version_value.IsString() ||
      !iterations_value.IsNumber()) {
    Napi::TypeError::New(env, "libraryPath, angleDirectory, expectedClientApiVersion, and iterations are required.")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const std::wstring library_path = Utf8ToWide(library_value.As<Napi::String>().Utf8Value());
  std::wstring angle_directory = Utf8ToWide(angle_value.As<Napi::String>().Utf8Value());
  const double iterations_number = iterations_value.As<Napi::Number>().DoubleValue();
  if (!IsAbsoluteDllPath(library_path) || !IsAbsoluteDirectoryPath(angle_directory)) {
    Napi::RangeError::New(env, "The library and ANGLE locations must be absolute controlled paths.")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (iterations_number < 1 || iterations_number > kMaximumSmokeIterations ||
      iterations_number != static_cast<uint32_t>(iterations_number)) {
    Napi::RangeError::New(env, "iterations must be an integer from 1 through 100.")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const uint32_t iterations = static_cast<uint32_t>(iterations_number);
  uint64_t expected_version = 0;
  if (!ParseApiVersion(version_value.As<Napi::String>().Utf8Value(), &expected_version)) {
    Napi::RangeError::New(env, "expectedClientApiVersion must be a major.minor value.")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  while (!angle_directory.empty() && (angle_directory.back() == L'\\' || angle_directory.back() == L'/')) {
    angle_directory.pop_back();
  }

  Module libmpv(library_path);
  LibMpvFunctions functions;
  if (!libmpv.loaded()) {
    Napi::Error::New(env, "LIBMPV_SECURE_LOAD_FAILED").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (!functions.Resolve(libmpv)) {
    Napi::Error::New(env, "LIBMPV_REQUIRED_SYMBOL_MISSING").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (functions.client_api_version() != expected_version) {
    Napi::Error::New(env, "LIBMPV_CLIENT_ABI_MISMATCH").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  AngleSharedTextureContext angle(angle_directory + L"\\libEGL.dll",
                                  angle_directory + L"\\libGLESv2.dll");
  if (const char* angle_error = angle.Initialize(); angle_error != nullptr) {
    Napi::Error::New(env, angle_error).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  mpv_opengl_init_params init_parameters{
    AngleSharedTextureContext::GetGlProcAddressCallback,
    &angle,
  };
  const char* api_type = "opengl";
  mpv_render_param render_parameters[] = {
    {1, const_cast<char*>(api_type)},
    {2, &init_parameters},
    {0, nullptr},
  };
  for (uint32_t iteration = 0; iteration < iterations; ++iteration) {
    MpvInstance instance(functions);
    if (!instance.created()) {
      Napi::Error::New(env, "LIBMPV_CREATE_FAILED").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    if (instance.Initialize() < 0) {
      Napi::Error::New(env, "LIBMPV_INITIALIZE_FAILED").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    MpvRenderContext render_context(functions);
    if (render_context.Create(instance.get(), render_parameters) < 0) {
      Napi::Error::New(env, "LIBMPV_RENDER_CONTEXT_CREATE_FAILED").ThrowAsJavaScriptException();
      return env.Undefined();
    }
  }

  Napi::Object result = Napi::Object::New(env);
  result.Set("clientApiVersion", FormatApiVersion(expected_version));
  result.Set("eglVersion", std::to_string(angle.egl_major()) + "." + std::to_string(angle.egl_minor()));
  result.Set("completedIterations", Napi::Number::New(env, iterations));
  result.Set("d3d11Device", Napi::Boolean::New(env, true));
  result.Set("shareableBgraTexture", Napi::Boolean::New(env, true));
  result.Set("angleTextureSurface", Napi::Boolean::New(env, true));
  result.Set("renderContextLifecycle", Napi::Boolean::New(env, true));
  return result;
}

}  // namespace

Napi::Object InitializeLibMpvRuntimeProbe(Napi::Env env, Napi::Object exports) {
  exports.Set("probeLibMpvRuntime", Napi::Function::New(env, ProbeLibMpvRuntime));
  exports.Set("probeLibMpvRenderContext", Napi::Function::New(env, ProbeLibMpvRenderContext));
  exports.Set("quarantinedVideoStateCount", Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
    return Napi::Number::New(info.Env(), static_cast<double>(g_quarantined_video_states.size()));
  }));
  return LibMpvVideoProducer::Initialize(env, exports);
}
