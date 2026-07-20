// cargo 不会因 env 变化自动重编译 `option_env!` 读到的值；声明 rerun-if-env-changed
// 让本地增量构建也能在改这个 env 后重编译（CI 全新构建本就不受影响）。见 main.rs SUPERVISOR_VERSION。
fn main() {
    println!("cargo:rerun-if-env-changed=COFLUX_RELEASE_VERSION");
}
