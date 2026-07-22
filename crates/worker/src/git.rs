//! git 操作：校验仓库、worktree 增删。与 TS git.ts 行为一致。

use std::process::Stdio;
use tokio::process::Command;

async fn run_git(args: &[&str]) -> (bool, String, String) {
    match Command::new("git").args(args).stdin(Stdio::null()).output().await {
        Ok(o) => (
            o.status.success(),
            String::from_utf8_lossy(&o.stdout).into_owned(),
            String::from_utf8_lossy(&o.stderr).into_owned(),
        ),
        Err(_) => (false, String::new(), String::new()),
    }
}

/// 读 worktree 当前分支：解析 `.git`(文件) → gitdir 下的 HEAD。
/// `ref: refs/heads/x` → x；detached → 短 sha。纯文件读取，不起 git 子进程。
pub fn current_branch(worktree: &str) -> Option<String> {
    let dotgit = std::path::Path::new(worktree).join(".git");
    let gitdir = if dotgit.is_file() {
        let content = std::fs::read_to_string(&dotgit).ok()?;
        let p = content.trim().strip_prefix("gitdir:")?.trim().to_string();
        let pb = std::path::PathBuf::from(&p);
        if pb.is_absolute() { pb } else { std::path::Path::new(worktree).join(pb) }
    } else {
        dotgit
    };
    let head = std::fs::read_to_string(gitdir.join("HEAD")).ok()?;
    let head = head.trim();
    if let Some(r) = head.strip_prefix("ref:") {
        let r = r.trim();
        Some(r.strip_prefix("refs/heads/").unwrap_or(r).to_string())
    } else {
        Some(head.chars().take(7).collect())
    }
}

pub struct DiffStat {
    pub additions: i32,
    pub deletions: i32,
}

/// 计算某 worktree 相对 default_branch 的累积 git diff：merge-base(default_branch, HEAD) 到
/// 工作树（一条 `git diff --shortstat <base>` 同时涵盖已提交与未提交改动），untracked 新文件
/// 行数另计入 additions。merge-base 解析失败（default_branch 已删/孤儿分支）时回退到
/// `git diff --shortstat HEAD`（仅未提交）。
pub async fn diff_stat(worktree: &str, default_branch: &str) -> DiffStat {
    let base = merge_base(worktree, default_branch).await;
    let diff_ref = base.as_deref().unwrap_or("HEAD");
    let (ok, out, _) = run_git(&["-C", worktree, "diff", "--shortstat", diff_ref]).await;
    let (mut additions, deletions) = if ok { parse_shortstat(&out) } else { (0, 0) };
    additions += untracked_additions(worktree).await;
    DiffStat { additions, deletions }
}

async fn merge_base(worktree: &str, default_branch: &str) -> Option<String> {
    if default_branch.trim().is_empty() {
        return None;
    }
    let (ok, out, _) = run_git(&["-C", worktree, "merge-base", default_branch, "HEAD"]).await;
    let sha = out.trim();
    (ok && !sha.is_empty()).then(|| sha.to_string())
}

/// 解析 `git diff --shortstat` 的输出（如 " 3 files changed, 10 insertions(+), 2 deletions(-)"）。
/// 缺失的 insertions/deletions 分支（比如全增无删、或全无改动的空输出）按 0 处理。
fn parse_shortstat(out: &str) -> (i32, i32) {
    let mut additions = 0i32;
    let mut deletions = 0i32;
    for part in out.split(',') {
        let part = part.trim();
        if let Some(n) = part.strip_suffix("insertion(+)").or_else(|| part.strip_suffix("insertions(+)")) {
            additions = n.trim().parse().unwrap_or(0);
        } else if let Some(n) = part.strip_suffix("deletion(-)").or_else(|| part.strip_suffix("deletions(-)")) {
            deletions = n.trim().parse().unwrap_or(0);
        }
    }
    (additions, deletions)
}

/// untracked 新文件不含尾随换行的末行也算 1 行，对齐 git numstat 语义；空文件 0 行。
/// 内容含 NUL 字节视为二进制，返回 None（调用方跳过，不计入统计）。
fn count_untracked_lines(data: &[u8]) -> Option<i32> {
    if data.contains(&0) {
        return None;
    }
    if data.is_empty() {
        return Some(0);
    }
    let newlines = data.iter().filter(|&&b| b == b'\n').count();
    let lines = if data.last() == Some(&b'\n') { newlines } else { newlines + 1 };
    Some(lines as i32)
}

/// worker 直接读 untracked 文件统计行数（无需为每个文件起 `git diff --no-index` 子进程）；
/// 单文件 >1MB 跳过（防大产物文件拖慢轮询）。
async fn untracked_additions(worktree: &str) -> i32 {
    let (ok, out, _) = run_git(&["-C", worktree, "ls-files", "--others", "--exclude-standard", "-z"]).await;
    if !ok {
        return 0;
    }
    let mut total = 0i32;
    for rel in out.split('\0').filter(|s| !s.is_empty()) {
        let path = std::path::Path::new(worktree).join(rel);
        let Ok(meta) = std::fs::metadata(&path) else { continue };
        if !meta.is_file() || meta.len() > 1_000_000 {
            continue;
        }
        let Ok(data) = std::fs::read(&path) else { continue };
        if let Some(lines) = count_untracked_lines(&data) {
            total += lines;
        }
    }
    total
}

pub struct RepoInfo {
    pub ok: bool,
    pub repo_path: String,
    pub branch: String,
    pub error: Option<String>,
    pub suggested_name: Option<String>,
}

pub struct WorktreeResult {
    pub ok: bool,
    pub path: String,
    pub branch: String,
    pub error: Option<String>,
}

pub async fn validate_repo(path: &str) -> RepoInfo {
    // 兼容 "~/rel"；导入向导现发绝对路径。落库仍取 --show-toplevel 的绝对真实路径。
    let path = &match crate::ops::expand_home(path) {
        Some(p) => p,
        None => path.to_string(),
    };
    let (ok, out, _) = run_git(&["-C", path, "rev-parse", "--show-toplevel"]).await;
    if !ok {
        return RepoInfo {
            ok: false,
            repo_path: path.to_string(),
            branch: String::new(),
            error: Some("不是 git 仓库".into()),
            suggested_name: None,
        };
    }
    let repo_path = out.trim().to_string();
    let (bok, bout, _) = run_git(&["-C", &repo_path, "rev-parse", "--abbrev-ref", "HEAD"]).await;
    let branch = if bok {
        let b = bout.trim();
        if b.is_empty() { "HEAD".into() } else { b.to_string() }
    } else {
        "HEAD".into()
    };
    let suggested_name = remote_project_name(&repo_path).await;
    RepoInfo { ok: true, repo_path, branch, error: None, suggested_name }
}

/// 只把 remote 的解析结果带出 worker；原始 URL 不进入协议、日志或错误。
async fn remote_project_name(repo_path: &str) -> Option<String> {
    let (ok, out, _) = run_git(&["-C", repo_path, "remote"]).await;
    if !ok {
        return None;
    }

    let names = ordered_remote_names(&out);
    let mut remotes = Vec::with_capacity(names.len());
    for name in names {
        let (ok, url, _) = run_git(&["-C", repo_path, "remote", "get-url", &name]).await;
        if ok {
            remotes.push((name, url.trim().to_string()));
        }
    }
    suggested_name_from_remotes(&remotes)
}

/// origin 固定优先；其余 remote 保持 `git remote` 的返回顺序。
fn ordered_remote_names(output: &str) -> Vec<String> {
    let names: Vec<String> = output
        .lines()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .collect();
    let mut ordered = Vec::with_capacity(names.len());
    if names.iter().any(|name| name == "origin") {
        ordered.push("origin".to_string());
    }
    ordered.extend(names.into_iter().filter(|name| name != "origin"));
    ordered
}

fn suggested_name_from_remotes(remotes: &[(String, String)]) -> Option<String> {
    remotes.iter().find_map(|(_, url)| project_name_from_remote(url))
}

fn project_name_from_remote(remote: &str) -> Option<String> {
    let remote = remote.trim();
    if let Some((scheme, rest)) = remote.split_once("://") {
        if !matches!(scheme, "http" | "https" | "ssh" | "git") {
            return None;
        }
        let (authority, path) = rest.split_once('/')?;
        if authority.is_empty() {
            return None;
        }
        return normalize_remote_path(path);
    }

    // SCP-like：要求显式 user@host，避免把 Windows 盘符或本地含冒号路径误判为网络 remote。
    let (endpoint, path) = remote.split_once(':')?;
    let (user, host) = endpoint.rsplit_once('@')?;
    if user.is_empty() || host.is_empty() || endpoint.contains('/') || endpoint.contains('\\') {
        return None;
    }
    normalize_remote_path(path)
}

fn normalize_remote_path(path: &str) -> Option<String> {
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() < 2
        || parts.iter().any(|part| {
            part.is_empty()
                || matches!(*part, "." | "..")
                || part.contains('\\')
                || part.contains('?')
                || part.contains('#')
        })
    {
        return None;
    }
    Some(parts.join("/"))
}

pub async fn add_worktree(worktrees_dir: &str, repo_path: &str, workspace_id: &str, branch: &str, create_new: bool) -> WorktreeResult {
    let _ = std::fs::create_dir_all(worktrees_dir);
    // 目录名只用稳定 id：branch 可被 checkout 换掉、name 是自由文本备注，都不适合当路径身份
    let dir = format!("{}/{}", worktrees_dir, workspace_id);
    let args: Vec<&str> = if create_new {
        vec!["-C", repo_path, "worktree", "add", "-b", branch, dir.as_str()]
    } else {
        vec!["-C", repo_path, "worktree", "add", dir.as_str(), branch]
    };
    let (ok, _o, err) = run_git(&args).await;
    if !ok {
        let e = err.trim();
        let e = if e.is_empty() { "git worktree add failed" } else { e };
        let error: String = e.chars().take(400).collect();
        return WorktreeResult { ok: false, path: dir, branch: branch.to_string(), error: Some(error) };
    }
    WorktreeResult { ok: true, path: dir, branch: branch.to_string(), error: None }
}

pub async fn remove_worktree(repo_path: &str, worktree_path: &str) {
    let (ok, _o, _e) = run_git(&["-C", repo_path, "worktree", "remove", "--force", worktree_path]).await;
    if !ok {
        let _ = run_git(&["-C", repo_path, "worktree", "prune"]).await;
    }
}

#[cfg(test)]
mod tests {
    use super::{count_untracked_lines, ordered_remote_names, parse_shortstat, project_name_from_remote, suggested_name_from_remotes};

    #[test]
    fn parses_shortstat_variants() {
        assert_eq!(parse_shortstat(" 3 files changed, 10 insertions(+), 2 deletions(-)"), (10, 2));
        assert_eq!(parse_shortstat(" 1 file changed, 1 insertion(+)"), (1, 0));
        assert_eq!(parse_shortstat(" 1 file changed, 1 deletion(-)"), (0, 1));
        assert_eq!(parse_shortstat(""), (0, 0));
    }

    #[test]
    fn counts_untracked_lines_and_detects_binary() {
        assert_eq!(count_untracked_lines(b""), Some(0));
        assert_eq!(count_untracked_lines(b"a\nb\n"), Some(2));
        // 末行无尾随换行也计为一行
        assert_eq!(count_untracked_lines(b"a\nb"), Some(2));
        assert_eq!(count_untracked_lines(b"no trailing newline"), Some(1));
        // NUL 字节判定为二进制，跳过统计
        assert_eq!(count_untracked_lines(b"a\0b"), None);
    }

    #[test]
    fn parses_common_network_remote_formats() {
        let cases = [
            ("https://github.com/myWsq/coflux.git", "myWsq/coflux"),
            ("http://git.example.com/group/subgroup/project.git", "group/subgroup/project"),
            ("ssh://git@git.example.com/group/project", "group/project"),
            ("git://git.example.com/group/project.git/", "group/project"),
            ("git@git.example.com:group/subgroup/project.git", "group/subgroup/project"),
        ];
        for (remote, expected) in cases {
            assert_eq!(project_name_from_remote(remote).as_deref(), Some(expected), "remote 格式：{remote}");
        }
    }

    #[test]
    fn rejects_local_or_unsafe_remote_values() {
        for remote in [
            "",
            "/srv/git/group/project.git",
            "../group/project.git",
            "C:\\git\\group\\project.git",
            "file:///srv/git/group/project.git",
            "https://git.example.com/project.git",
            "ssh://git@git.example.com/",
            "git@example.com:../private/project.git",
        ] {
            assert_eq!(project_name_from_remote(remote), None, "remote 应被拒绝：{remote}");
        }
    }

    #[test]
    fn origin_precedes_other_remotes_and_invalid_values_are_skipped() {
        assert_eq!(
            ordered_remote_names("backup\norigin\nmirror\n"),
            vec!["origin".to_string(), "backup".to_string(), "mirror".to_string()]
        );

        let valid_origin = vec![
            ("origin".into(), "https://git.example.com/team/main.git".into()),
            ("backup".into(), "https://git.example.com/team/backup.git".into()),
        ];
        assert_eq!(suggested_name_from_remotes(&valid_origin).as_deref(), Some("team/main"));

        let invalid_origin = vec![
            ("origin".into(), "/local/private.git".into()),
            ("backup".into(), "file:///local/private.git".into()),
            ("mirror".into(), "git@git.example.com:group/project.git".into()),
        ];
        assert_eq!(suggested_name_from_remotes(&invalid_origin).as_deref(), Some("group/project"));
    }
}
