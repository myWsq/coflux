//! 把调用方申报的 cwd 解析成本设备上的工作区（plan 102）。
//!
//! agent 可以经 `/cd` 或 EnterWorktree 把**活着的**会话挪进同设备的另一个 coflux 工作区
//! （子工作区就是 `~/.coflux/worktrees/<workspace_id>` 下一个正规注册的 git worktree）。
//! 挪窝之后本地命令若仍按「会话账本里的归属」办事，就会在 A 名下建 task、在 A 的目录里跑，
//! 而 agent 以为自己在 B——沉默错位比报错更坏。所以每条 `/agent` 请求都带 cwd，由这里解析出
//! **有效工作区**。
//!
//! 判据是「本设备工作区表里路径包含该 cwd 的那个工作区」，按**路径分量**做最长前缀匹配：
//! - 按分量比而不是按字符串前缀比，否则 `/x/repo` 会命中 `/x/repo2`；
//! - 两边都先 `canonicalize`：macOS 的 `/var` 实为 `/private/var`，`~/.coflux` 也可能是符号
//!   链接，而表里的路径是中心记录的用户原始写法，未必规范。规范化失败（路径已不存在）则退回
//!   字面比较——错过一次匹配只是退回归属工作区，不会错位到别的工作区；
//! - 取最长命中：主工作区路径下就嵌着子工作区（还没登记的 Claude 自建 `.claude/worktrees/*`
//!   被算进主工作区正是想要的行为——plan 104 一旦把它登记成子工作区，它的路径更长，这里自然
//!   优先命中它；「该不该登记」是 [`crate::worktree_locate`] 的事，那里按路径**相等**判定）；
//! - 目录工作区（default_branch 为空）同样参与——它也是一个用户看得见的工作区。
//!
//! 这里只回答「目标是谁」。**归属**（会话在哪个工作区开的）永远只来自中心随 SessionCreate
//! 下发的 workspace_id，缺失就缺失，绝不按 cwd 补（plans/094 Decisions）。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// cwd 命中的工作区 id（最长前缀）；不在任何已知工作区内则 None。
///
/// `workspaces` 就是 `WorkerState.workspaces`：workspace_id -> (路径, default_branch)。
pub(crate) fn workspace_for_cwd(
    workspaces: &HashMap<String, (String, String)>,
    cwd: &str,
) -> Option<String> {
    if cwd.trim().is_empty() {
        return None;
    }
    let cwd = normalize(cwd);
    let mut best: Option<(usize, &str)> = None;
    for (id, (path, _default_branch)) in workspaces {
        if path.trim().is_empty() {
            continue;
        }
        let Some(depth) = contains_depth(&normalize(path), &cwd) else {
            continue;
        };
        // 同深度只会出现在「两个工作区登记了同一路径」的畸形数据上：按 id 取定值，别让
        // HashMap 的遍历顺序把结果做成随机的。
        let better = match best {
            None => true,
            Some((best_depth, best_id)) => depth > best_depth || (depth == best_depth && id.as_str() < best_id),
        };
        if better {
            best = Some((depth, id.as_str()));
        }
    }
    best.map(|(_, id)| id.to_string())
}

/// 规范化失败（路径不存在/权限不足）就用字面路径——宁可错过匹配，也不猜。
fn normalize(path: &str) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path))
}

/// `cwd` 落在 `root` 之内（含相等）时返回 root 的分量数，否则 None。分量数即「匹配深度」，
/// 越深越具体。
fn contains_depth(root: &Path, cwd: &Path) -> Option<usize> {
    let mut root_parts = root.components();
    let mut cwd_parts = cwd.components();
    let mut depth = 0usize;
    loop {
        match (root_parts.next(), cwd_parts.next()) {
            // root 走完 = cwd 在它之内（或就是它）
            (None, _) => return Some(depth),
            (Some(left), Some(right)) if left == right => depth += 1,
            _ => return None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table(entries: &[(&str, &str, &str)]) -> HashMap<String, (String, String)> {
        entries
            .iter()
            .map(|(id, path, branch)| ((*id).to_string(), ((*path).to_string(), (*branch).to_string())))
            .collect()
    }

    #[test]
    fn nested_workspace_wins_over_its_parent() {
        let ws = table(&[
            ("main", "/x/repo", "main"),
            ("child", "/x/repo/.coflux/worktrees/child", "main"),
        ]);
        assert_eq!(workspace_for_cwd(&ws, "/x/repo/src").as_deref(), Some("main"));
        assert_eq!(
            workspace_for_cwd(&ws, "/x/repo/.coflux/worktrees/child/crates").as_deref(),
            Some("child"),
        );
        // 主工作区路径下 Claude 自建的 worktree（coflux 不认识）算进主工作区，不特判
        assert_eq!(
            workspace_for_cwd(&ws, "/x/repo/.claude/worktrees/abc").as_deref(),
            Some("main"),
        );
    }

    #[test]
    fn prefix_match_is_by_path_component() {
        let ws = table(&[("main", "/x/repo", "main")]);
        assert_eq!(workspace_for_cwd(&ws, "/x/repo").as_deref(), Some("main"));
        assert_eq!(workspace_for_cwd(&ws, "/x/repo2"), None, "/x/repo 不能命中 /x/repo2");
        assert_eq!(workspace_for_cwd(&ws, "/x/repo-old"), None);
        assert_eq!(workspace_for_cwd(&ws, "/x"), None, "上级目录不算在工作区内");
    }

    #[test]
    fn cwd_outside_every_workspace_matches_nothing() {
        let ws = table(&[("main", "/x/repo", "main"), ("dir", "/y/notes", "")]);
        assert_eq!(workspace_for_cwd(&ws, "/tmp/scratch"), None);
        assert_eq!(workspace_for_cwd(&ws, ""), None);
        assert_eq!(workspace_for_cwd(&ws, "   "), None);
        assert_eq!(workspace_for_cwd(&HashMap::new(), "/x/repo"), None);
    }

    #[test]
    fn directory_workspaces_participate() {
        // default_branch 为空 = 目录工作区（无 repo 终端）：git 轮询跳过它，归属解析不跳过
        let ws = table(&[("dir", "/y/notes", "")]);
        assert_eq!(workspace_for_cwd(&ws, "/y/notes/daily").as_deref(), Some("dir"));
    }

    #[test]
    fn symlinked_paths_are_canonicalized_on_both_sides() {
        let base = std::env::temp_dir().join(format!("coflux-wsmatch-{}", std::process::id()));
        let real = base.join("real");
        let inner = real.join("inner");
        let link = base.join("link");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&inner).expect("建测试目录");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real, &link).expect("建符号链接");

        // 表里登记的是符号链接路径，调用方报的是真实路径（macOS 的 /var → /private/var 同理）
        let ws = table(&[("linked", link.to_str().unwrap(), "main")]);
        assert_eq!(
            workspace_for_cwd(&ws, inner.to_str().unwrap()).as_deref(),
            Some("linked"),
            "两边都要规范化",
        );
        // 反过来也要成立：表里是真实路径，调用方报的是链接路径
        let ws = table(&[("real", real.to_str().unwrap(), "main")]);
        assert_eq!(
            workspace_for_cwd(&ws, link.join("inner").to_str().unwrap()).as_deref(),
            Some("real"),
        );
        let _ = std::fs::remove_dir_all(&base);
    }
}
