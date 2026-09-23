//! 账号客户端：短命令连接公共操作层；结束命令不会停止任何本机或远端终端。
use crate::args::ParsedArgs;
use crate::handle;
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::{self, BufRead, Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::Duration;

fn home() -> PathBuf {
    std::env::var_os("COFLUX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".coflux")
        })
}
fn origin(raw: &str) -> Result<String, String> {
    let raw = raw
        .replacen("wss://", "https://", 1)
        .replacen("ws://", "http://", 1);
    let url = url::Url::parse(&raw).map_err(|_| "服务器地址无效")?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("服务器地址不能包含凭据".into());
    }
    let local = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    if url.scheme() != "https" && !(url.scheme() == "http" && local) {
        return Err("服务器必须使用 HTTPS（本机开发可用 HTTP）".into());
    }
    Ok(url.origin().ascii_serialization())
}
fn response(value: Value) -> Result<Value, String> {
    if value["ok"] == true {
        Ok(value["value"].clone())
    } else {
        Err(value["error"].as_str().unwrap_or("请求失败").to_string())
    }
}
fn http(
    server: &str,
    path: &str,
    token: Option<&str>,
    body: Value,
    timeout: u64,
) -> Result<Value, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(timeout))
        .redirects(0)
        .build();
    let mut request = agent.post(&format!("{server}{path}"));
    if let Some(token) = token {
        request = request.set("Authorization", &format!("Bearer {token}"));
    }
    let result = match request.send_json(body) {
        Ok(r) => r,
        Err(ureq::Error::Status(_, r)) => r,
        Err(_) => {
            return Err(
                "无法连接账号服务器，请检查网络后重试；写操作请先查询结果，勿重复提交".into(),
            )
        }
    };
    let mut text = String::new();
    result
        .into_reader()
        .take(8 * 1024 * 1024 + 1)
        .read_to_string(&mut text)
        .map_err(|_| "服务器响应读取失败")?;
    if text.len() > 8 * 1024 * 1024 {
        return Err("服务器响应过大".into());
    }
    response(serde_json::from_str(&text).map_err(|_| "服务器响应无效或不支持账号命令")?)
}
fn save(value: &Value) -> Result<(), String> {
    fs::create_dir_all(home()).map_err(|e| e.to_string())?;
    fs::set_permissions(home(), fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    let path = home().join(format!("cli-session.{}.tmp", std::process::id()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .map_err(|e| e.to_string())?;
        file.write_all(value.to_string().as_bytes())
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        fs::rename(&path, home().join("cli-session.json")).map_err(|e| e.to_string())
    })();
    let _ = fs::remove_file(path);
    result
}
fn broker(command: &Value, timeout: u64) -> Result<Value, String> {
    let mut stream = UnixStream::connect(home().join("client.sock"))
        .map_err(|_| "请先登录 Coflux 应用或运行 coflux login")?;
    stream
        .set_read_timeout(Some(Duration::from_secs(timeout)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;
    writeln!(stream, "{}", json!({"protocolVersion":1,"command":command}))
        .map_err(|e| e.to_string())?;
    let mut text = String::new();
    stream
        .take(8 * 1024 * 1024 + 1)
        .read_to_string(&mut text)
        .map_err(|_| "Coflux 应用连接已中断，请查询操作结果")?;
    if text.len() > 8 * 1024 * 1024 {
        return Err("响应过大".into());
    }
    response(serde_json::from_str(&text).map_err(|_| "Coflux 应用响应无效")?)
}
fn required<'a>(args: &'a ParsedArgs, key: &str) -> Result<&'a str, String> {
    args.string(key)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("缺少 --{key}"))
}
fn id(args: &ParsedArgs) -> Result<&str, String> {
    args.positional(2).ok_or_else(|| "缺少目标 ID".into())
}

/// A path that will be resolved on the **target device**: absolute, or a `~` prefix. Same rule as
/// `device exec --cwd`; expanding it here would resolve the caller's home on the wrong machine.
fn device_path(path: &str) -> bool {
    path.starts_with('/') || path == "~" || path.starts_with("~/")
}

/// `project import <path>` 的路径位；措辞要说的是「路径」，不是 `id()` 的「目标 ID」。
fn import_path(args: &ParsedArgs) -> Result<&str, String> {
    let path = args
        .positional(2)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or("缺少要导入的路径（导入当前目录写 coflux project import \"$PWD\"）")?;
    if !device_path(path) {
        return Err("路径要绝对路径或 ~ 开头（它在目标设备上解析）；导入当前目录写 coflux project import \"$PWD\"".into());
    }
    Ok(path)
}

/// `--device` 缺省回落到 daemon 注入的 COFLUX_DEVICE_ID；两处都空就报错，绝不替用户猜设备。
fn device_target(args: &ParsedArgs) -> Result<String, String> {
    if let Some(value) = args.string("device").map(str::trim).filter(|v| !v.is_empty()) {
        return Ok(value.to_string());
    }
    let from_env = std::env::var("COFLUX_DEVICE_ID").unwrap_or_default();
    let from_env = from_env.trim();
    if from_env.is_empty() {
        return Err("缺少设备：请加 --device <id>（coflux device list 可以看到）".into());
    }
    Ok(from_env.to_string())
}

/// `device exec` 自身失败（够不到设备、参数错、超时）用的退出码，ssh 的约定：远端退出码占满
/// 0-254，255 留给「命令根本没跑成」。别的账号命令仍走 [`crate::die`] 的 1。
const EXEC_CLI_FAILURE: i32 = 255;
/// exec 的默认超时（秒）；上限由中心与设备各自钳制在 600。
const EXEC_DEFAULT_TIMEOUT_SECS: &str = "60";

/// 跑一次 `coflux device exec`，返回要透传的远端退出码。
fn device_exec(
    args: &ParsedArgs,
    call: &dyn Fn(Value) -> Result<Value, String>,
) -> Result<i32, String> {
    let device_id = args
        .positional(2)
        .filter(|value| !value.is_empty())
        .ok_or("缺少设备 ID（coflux device list 可以看到）")?;
    let command = required(args, "cmd")?;
    let timeout = args
        .string("timeout")
        .unwrap_or(EXEC_DEFAULT_TIMEOUT_SECS)
        .parse::<u32>()
        .map_err(|_| "--timeout 必须是整数秒")?;
    // 上限在这里就说清楚，别让中心的入参校验回一句「请求失败」。
    if !(1..=600).contains(&timeout) {
        return Err("--timeout 取 1-600 秒；更久、或需要用户看见的长任务请改用 coflux terminal new".into());
    }
    let value = call(json!({
        "op": "device.exec",
        "deviceId": device_id,
        "command": command,
        "cwd": args.string("cwd").unwrap_or(""),
        "timeout": timeout,
    }))?;
    let exit_code = value["exitCode"]
        .as_i64()
        .ok_or("设备回执缺少退出码（中心版本过旧？）")?;
    // 顺序固定：stdout、stderr、`# exit=`；每段写完就 flush，终端里的先后次序才与远端一致。
    let mut out = io::stdout().lock();
    let _ = out.write_all(value["stdout"].as_str().unwrap_or("").as_bytes());
    let _ = out.flush();
    let mut err = io::stderr().lock();
    let _ = err.write_all(value["stderr"].as_str().unwrap_or("").as_bytes());
    let _ = err.flush();
    let _ = writeln!(out, "# exit={exit_code}");
    let _ = out.flush();
    Ok(exit_code as i32)
}

pub fn handles(args: &ParsedArgs) -> bool {
    match args.positional(0).unwrap_or("") {
        "login" | "logout" | "whoami" | "device" | "project" => true,
        "workspace" => matches!(
            args.positional(1),
            Some("list" | "new" | "rename" | "remove")
        ),
        "terminal" | "ports" => {
            args.flag("remote")
                || args.string("workspace").is_some()
                || args.string("device").is_some()
                || (std::env::var("COFLUX_TASK_ID")
                    .unwrap_or_default()
                    .is_empty()
                    && (home().join("cli-session.json").exists()
                        || home().join("client.sock").exists()))
        }
        _ => false,
    }
}
pub fn run(args: &ParsedArgs) -> Result<(), String> {
    let command = args.positional(0).unwrap_or("");
    if command == "login" {
        let server = origin(args.string("server").unwrap_or("https://api.coflux.dev"))?;
        // No credential flags: sign in through the browser (loopback + PKCE, or a paste code over SSH).
        if args.string("username").is_none() && !args.flag("password-stdin") {
            let post = |path: &str, body: Value| http(&server, path, None, body, 30);
            let granted = crate::browser_login::run(&server, &post)?;
            save(&json!({"server":server,"token":granted.token,"accountId":granted.account_id}))?;
            let who = if granted.login.is_empty() { "当前账号".to_string() } else { granted.login };
            println!("已登录为 {who}");
            return Ok(());
        }
        let username = required(args, "username")?;
        if !args.flag("password-stdin") {
            return Err(
                "用 --password-stdin 从标准输入读取密码；密码不进入命令参数或配置文件".into(),
            );
        }
        let mut password = String::new();
        io::stdin()
            .lock()
            .take(4097)
            .read_line(&mut password)
            .map_err(|e| e.to_string())?;
        let value = http(
            &server,
            "/api/client/login",
            None,
            json!({"protocolVersion":1,"username":username,"password":password.trim_end_matches(['\r','\n'])}),
            30,
        )?;
        save(&json!({"server":server,"token":value["token"],"accountId":value["accountId"]}))?;
        println!(
            "{}",
            json!({"accountId":value["accountId"],"server":server})
        );
        return Ok(());
    }
    let session = match fs::read(home().join("cli-session.json")) {
        Ok(bytes) => Some(
            serde_json::from_slice::<Value>(&bytes).map_err(|_| "CLI 登录记录损坏，请重新登录")?,
        ),
        Err(e) if e.kind() == io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    // `terminal wait` 与 `device exec` 都可能在中心侧阻塞到 600 秒；HTTP 超时必须给它们让路，
    // 否则 `--timeout=300` 会先在 CLI 这一侧被切断。其余账号操作 40 秒足够。
    let long_running = matches!(
        (command, args.positional(1)),
        ("terminal", Some("wait")) | ("device", Some("exec"))
    );
    let timeout = if long_running { 610 } else { 40 };
    let call = |operation: Value| -> Result<Value, String> {
        if let Some(session) = &session {
            let server = origin(session["server"].as_str().ok_or("CLI 服务器记录无效")?)?;
            if let Some(requested) = args.string("server") {
                if origin(requested)? != server {
                    return Err("目标服务器与登录记录不一致，请先登录目标服务器".into());
                }
            }
            let token = session["token"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or("请先登录")?;
            http(
                &server,
                "/api/client/command",
                Some(token),
                json!({"protocolVersion":1,"command":operation}),
                timeout,
            )
        } else {
            if args.string("server").is_some() {
                return Err("请先登录指定服务器".into());
            }
            broker(&operation, timeout)
        }
    };
    if command == "logout" {
        if session.is_none() {
            return Err("此 CLI 未单独登录；应用账号请在 Coflux 中退出".into());
        }
        call(json!({"op":"logout"}))?;
        fs::remove_file(home().join("cli-session.json")).map_err(|e| e.to_string())?;
        println!("{}", json!({"loggedOut":true}));
        return Ok(());
    }
    // `device exec`：一次性跨设备执行，ssh 语义——不是终端，所以输出也不是 JSON：stdout 进
    // stdout、stderr 进 stderr（两条流始终分开），最后一行 `# exit=<code>`，进程退出码**透传
    // 远端**。本 CLI 自身的失败（设备离线、能力缺失、cwd 不对、超时、参数错）一律 255，这样
    // 调用方的 shell 判断能把「远端命令返回 1」与「根本没跑成」分开——其余命令仍用 die 的 1。
    if command == "device" && args.positional(1) == Some("exec") {
        match device_exec(args, &call) {
            Ok(code) => std::process::exit(code),
            Err(message) => {
                eprintln!("✗ {message}");
                std::process::exit(EXEC_CLI_FAILURE);
            }
        }
    }
    let sub = args.positional(1).unwrap_or("list");
    let operation = match (command, sub) {
        // 路径与项目名都原样交给中心：仓库根（`git rev-parse --show-toplevel`）与 `~` 展开
        // 是目标设备的事，CLI 只校验路径形状，避免把本机的 HOME 解析到别的机器上。
        ("project", "import") => {
            json!({"op":"project.import","daemonId":device_target(args)?,"path":import_path(args)?,"name":args.string("name")})
        }
        ("workspace", "new") => {
            json!({"op":"workspace.new","projectId":required(args,"project")?,"branch":required(args,"branch")?,"createNew":!args.flag("existing-branch"),"name":args.string("name")})
        }
        ("workspace", "rename") => {
            json!({"op":"workspace.rename","workspaceId":id(args)?,"name":required(args,"name")?})
        }
        ("workspace", "remove") => json!({"op":"workspace.remove","workspaceId":id(args)?}),
        ("terminal", "new") => {
            json!({"op":"terminal.new","workspaceId":required(args,"workspace")?,"title":args.string("title").unwrap_or(""),"command":args.string("cmd").unwrap_or("")})
        }
        ("terminal", "run") => {
            json!({"op":"terminal.run","terminalId":id(args)?,"command":required(args,"cmd")?})
        }
        ("terminal", "read") => {
            json!({"op":"terminal.read","terminalId":id(args)?,"lines":args.string("lines").unwrap_or("200").parse::<u32>().map_err(|_| "--lines 必须是整数")?})
        }
        ("terminal", "send") => {
            json!({"op":"terminal.send","terminalId":id(args)?,"text":required(args,"text")?,"enter":args.flag("enter")})
        }
        ("terminal", "wait") => {
            json!({"op":"terminal.wait","terminalId":id(args)?,"timeout":args.string("timeout").unwrap_or("30").parse::<u32>().map_err(|_| "--timeout 必须是整数")?})
        }
        ("terminal", "stop" | "remove") => {
            json!({"op":format!("terminal.{sub}"),"terminalId":id(args)?})
        }
        ("whoami" | "ports", _) | ("device" | "project" | "workspace" | "terminal", "list") => {
            json!({"op":"snapshot"})
        }
        _ => return Err("未知账号命令".into()),
    };
    // `project.import` 与 snapshot 一样按设备寻址，所以 `--device` 对它是入参而非筛选参数。
    if operation["op"] != "snapshot"
        && ((args.string("device").is_some() && operation["op"] != "project.import")
            || (args.string("workspace").is_some() && operation["op"] != "terminal.new"))
    {
        return Err("目标 ID 已确定作用范围，请不要附加设备或工作区筛选参数".into());
    }
    let mut operation = operation;
    if operation["name"].is_null() {
        operation.as_object_mut().unwrap().remove("name");
    }
    let mut value = call(operation)?;
    if command == "whoami" {
        value = json!({"accountId":value["accountId"]});
    } else if sub == "list" || command == "ports" {
        let field = match command {
            "device" => "devices",
            "project" => "projects",
            "workspace" => "workspaces",
            "terminal" => "terminals",
            "ports" => "ports",
            _ => unreachable!(),
        };
        // 这两个筛选是**客户端字符串比较**，不经中心解析：标识不在这里认，就会一个都匹配不上、
        // 打印一个空列表还不报错。类型给错（拿工作区标识填 --device）同样先说清楚再说。
        if let Some(target) = args.string("device") {
            handle::check_filter("device", handle::HandleKind::Device, target)?;
        }
        if let Some(target) = args.string("workspace") {
            handle::check_filter("workspace", handle::HandleKind::Workspace, target)?;
        }
        let items = value[field].as_array().ok_or("账号快照无效")?;
        value = Value::Array(
            items
                .iter()
                .filter(|item| {
                    args.string("device").map_or(true, |target| {
                        handle::matches(target, item["daemonId"].as_str(), handle::HandleKind::Device)
                    }) && args.string("workspace").map_or(true, |target| {
                        handle::matches(
                            target,
                            item["workspaceId"].as_str(),
                            handle::HandleKind::Workspace,
                        ) || (command == "workspace"
                            && handle::matches(
                                target,
                                item["id"].as_str(),
                                handle::HandleKind::Workspace,
                            ))
                    })
                })
                .cloned()
                .collect(),
        );
    }
    println!("{}", value);
    Ok(())
}
