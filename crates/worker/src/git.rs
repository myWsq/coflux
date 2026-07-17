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

fn sanitize(s: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for c in s.chars() {
        if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
            out.push(c);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    let trimmed: String = out.trim_matches('-').chars().take(40).collect();
    if trimmed.is_empty() {
        "ws".to_string()
    } else {
        trimmed
    }
}

pub struct RepoInfo {
    pub ok: bool,
    pub repo_path: String,
    pub branch: String,
    pub error: Option<String>,
}

pub struct WorktreeResult {
    pub ok: bool,
    pub path: String,
    pub branch: String,
    pub error: Option<String>,
}

pub async fn validate_repo(path: &str) -> RepoInfo {
    // 支持 "~/rel" 输入（导入向导发 home 相对路径）；落库路径仍是下方 --show-toplevel 的绝对真实路径。
    let path = &match crate::ops::expand_home(path) {
        Some(p) => p,
        None => path.to_string(),
    };
    let (ok, out, _) = run_git(&["-C", path, "rev-parse", "--show-toplevel"]).await;
    if !ok {
        return RepoInfo { ok: false, repo_path: path.to_string(), branch: String::new(), error: Some("不是 git 仓库".into()) };
    }
    let repo_path = out.trim().to_string();
    let (bok, bout, _) = run_git(&["-C", &repo_path, "rev-parse", "--abbrev-ref", "HEAD"]).await;
    let branch = if bok {
        let b = bout.trim();
        if b.is_empty() { "HEAD".into() } else { b.to_string() }
    } else {
        "HEAD".into()
    };
    RepoInfo { ok: true, repo_path, branch, error: None }
}

pub async fn add_worktree(worktrees_dir: &str, repo_path: &str, workspace_id: &str, name: &str, branch: &str, create_new: bool) -> WorktreeResult {
    let _ = std::fs::create_dir_all(worktrees_dir);
    let dir = format!("{}/{}-{}", worktrees_dir, sanitize(name), workspace_id);
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
