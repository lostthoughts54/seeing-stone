{
  "targets": [
    {
      "target_name": "seeing_stone_libmpv_bridge",
      "sources": [
        "src/synthetic_texture_producer.cc",
        "src/libmpv_runtime_probe.cc"
      ],
      "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "libraries": ["d3d11.lib", "dxgi.lib"],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "AdditionalOptions": ["/std:c++20", "/permissive-", "/W4"],
          "ExceptionHandling": 0
        }
      }
    }
  ]
}
