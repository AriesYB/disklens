fn main() {
    tauri_build::build();

    // ===== Windows GNU 工具链的本机自愈 =====
    if std::env::var("TARGET")
        .map(|t| t.ends_with("windows-gnu"))
        .unwrap_or(false)
    {
        let slash_fix = |p: String| p.replace('\\', "/");

        // 1) WebView2Loader.dll 只在 webview2-com-sys 的构建输出（out/x64）里，
        //    而 lib 测试的可执行文件在 target/debug/deps/ 下，运行时按
        //    「exe 所在目录 → PATH」找 DLL，deps 里没有就会从 PATH 捡到错误
        //    版本（STATUS_ENTRYPOINT_NOT_FOUND）。复制 x64 版进 deps。
        let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default();
        let root = std::path::Path::new(&manifest);
        let deps = root.join("target/debug/deps");
        let _ = std::fs::create_dir_all(&deps);
        let build_root = root.join("target/debug/build");
        if let Ok(entries) = std::fs::read_dir(&build_root) {
            for e in entries.flatten() {
                let dll = e.path().join("out").join("x64").join("WebView2Loader.dll");
                if dll.is_file() {
                    let _ = std::fs::copy(&dll, deps.join("WebView2Loader.dll"));
                    break;
                }
            }
        }

        // 2) lib 测试没有嵌入 manifest，comctl32 解析到 v5.82（缺
        //    TaskDialogIndirect——rfd 文件对话框的静态导入），加载即
        //    STATUS_ENTRYPOINT_NOT_FOUND。用 windres 编一份 v6 manifest
        //    链接给测试可执行文件（主程序由 tauri-build 已嵌，不受影响）。
        let out_dir = slash_fix(std::env::var("OUT_DIR").unwrap_or_default());
        if !out_dir.is_empty() {
            let xml = format!("{}/test-manifest.xml", out_dir);
            let _ = std::fs::write(
                &xml,
                "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\
                 <assembly xmlns=\"urn:schemas-microsoft-com:asm.v1\" manifestVersion=\"1.0\">\n\
                 \x20 <dependency>\n\
                 \x20   <dependentAssembly>\n\
                 \x20     <assemblyIdentity type=\"win32\" name=\"Microsoft.Windows.Common-Controls\" version=\"6.0.0.0\" processorArchitecture=\"*\" publicKeyToken=\"6595b64144ccf1df\" language=\"*\"/>\n\
                 \x20   </dependentAssembly>\n\
                 \x20 </dependency>\n\
                 </assembly>\n",
            );
            let rc = format!("{}/test-manifest.rc", out_dir);
            let _ = std::fs::write(&rc, format!("1 24 \"{}\"\n", xml));
            let obj = format!("{}/test-manifest.o", out_dir);
            let st = std::process::Command::new("windres")
                .args(["-O", "coff", "-o", &obj, &rc])
                .status();
            match st {
                Ok(s) if s.success() => println!("cargo:rustc-link-arg={}", obj),
                _ => println!(
                    "cargo:warning=windres 不可用：lib 测试将缺 comctl32 v6 manifest（TaskDialogIndirect 缺入口点）"
                ),
            }
        }
    }
}
