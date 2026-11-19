// 冒烟：确保包存在集成测试目标（build.rs 的 cargo:rustc-link-arg-tests 需要它）
#[test]
fn smoke() {
    assert_eq!(2 + 2, 4);
}
