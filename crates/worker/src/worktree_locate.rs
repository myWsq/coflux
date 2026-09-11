//! 跟随 agent 进入 worktree 的**定位**判据（plan 104）。
//!
//! Claude Code 的 `EnterWorktree` 把活着的会话切进一个 git worktree（自建的落在
//! `<主工作区>/.claude/worktrees/<name>`，分支 `worktree-<name>`），`ExitWorktree` 切回，
//! `--resume` 一个曾进入 worktree 的会话则在启动时直接把它放回去。coflux 跟着走：终端的
//! **归属**工作区搬到那个目录对应的工作区，没登记过就先登记。
//!
//! 这里只回答本地才答得出的三件事，答完交中心核验落库（归属的唯一真相在中心）：
//! 1. 目标目录属于哪个 worktree 根（`git rev-parse --show-toplevel`）；
//! 2. 该根在本设备工作区表里有没有对应记录——按规范化后的**相等**比较，**不是**最长前缀。
//!    这正是与 [`crate::workspace_match`]（plan 102 的「本次请求的目标」）分开的理由：Claude
//!    自建的 worktree 嵌在主工作区目录之下，前缀匹配会把它算进主工作区，永远登记不出来。
//!    登记之后子工作区的路径更长，102 的前缀匹配自然会优先命中它，两边不打架；
//! 3. 它和发起方的归属工作区是不是同一个 git 仓库（`git rev-parse --git-common-dir` 相等）。
//!    跨仓库、非 git、目录工作区起步一律「不适用」——什么都不建、什么都不搬。
//!
//! 判据做成纯函数（git 事实由 [`crate::git::repo_facts`] 先读出来再传进来），好在单测里覆盖
//! 全部分支而不必真起 git 子进程。

use std::collections::HashMap;
use std::path::PathBuf;

/// 一个目录的 git 事实。非 git 目录没有它（`None`）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RepoFacts {
    /// `git rev-parse --show-toplevel`：该 worktree 的根（git 给的绝对路径，未必已规范化）
    pub root: String,
    /// 该 worktree 的当前分支；detached 时是短 sha
    pub branch: String,
    /// `git rev-parse --path-format=absolute --git-common-dir`：同一仓库的所有 worktree 相同，
    /// 是「是不是同一个仓库」的判据
    pub common_dir: String,
}

/// 定位结论。`NotApplicable` 的文案直接回给 agent，所以每条都要说清为什么不跟随。
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Locate {
    /// 目标已经是一个登记过的工作区：直接搬过去，不新建
    Existing {
        workspace_id: String,
        root: String,
        branch: String,
    },
    /// 同仓库但未登记（Claude 自建的 worktree）：先登记再搬
    Register { root: String, branch: String },
    /// 不适用：静默不动、会话照常
    NotApplicable(&'static str),
}

/// 归属工作区与目标目录的 git 事实都读好之后，给出本次定位的结论。
pub(crate) fn decide(
    workspaces: &HashMap<String, (String, String)>,
    owning: Option<&RepoFacts>,
    target: Option<&RepoFacts>,
) -> Locate {
    let Some(owning) = owning else {
        return Locate::NotApplicable(
            "本终端开在目录工作区（无 git 仓库），coflux 不跟随 worktree",
        );
    };
    let Some(target) = target else {
        return Locate::NotApplicable("目标目录不是 git 仓库，coflux 不跟随");
    };
    if normalize(&owning.common_dir) != normalize(&target.common_dir) {
        return Locate::NotApplicable(
            "目标 worktree 属于另一个 git 仓库，coflux 只在本项目内跟随",
        );
    }
    match workspace_at_root(workspaces, &target.root) {
        Some(workspace_id) => Locate::Existing {
            workspace_id,
            root: normalize_display(&target.root),
            branch: target.branch.clone(),
        },
        None => Locate::Register {
            root: normalize_display(&target.root),
            branch: target.branch.clone(),
        },
    }
}

/// 本设备工作区表里路径**等于** `root` 的那个工作区（两边都规范化）。
///
/// `workspaces` 就是 `WorkerState.workspaces`：workspace_id -> (路径, default_branch)。
pub(crate) fn workspace_at_root(
    workspaces: &HashMap<String, (String, String)>,
    root: &str,
) -> Option<String> {
    if root.trim().is_empty() {
        return None;
    }
    let root = normalize(root);
    let mut best: Option<&str> = None;
    for (id, (path, _default_branch)) in workspaces {
        if path.trim().is_empty() || normalize(path) != root {
            continue;
        }
        // 同一路径登记了两条（畸形数据）时按 id 取定值，别让 HashMap 的遍历顺序把结果做成随机的。
        best = Some(match best {
            None => id.as_str(),
            Some(current) => current.min(id.as_str()),
        });
    }
    best.map(str::to_string)
}

/// 规范化后的字符串形式；上报给中心的路径用它（登记时落库的就是这一份）。
pub(crate) fn normalize_display(path: &str) -> String {
    normalize(path)
        .to_str()
        .map(str::to_string)
        .unwrap_or_else(|| path.to_string())
}

/// 规范化：先 `canonicalize`（macOS 的 `/var` 实为 `/private/var`，`~/.coflux` 也可能是符号链接）；
/// 路径已经不存在（WorktreeRemove 时目录刚被删）就退回「父目录规范化 + 原文件名」，父目录也不行
/// 才用字面值。宁可错过一次匹配，也不猜到别的工作区头上。
fn normalize(path: &str) -> PathBuf {
    let raw = PathBuf::from(path);
    if let Ok(real) = std::fs::canonicalize(&raw) {
        return real;
    }
    if let (Some(parent), Some(name)) = (raw.parent(), raw.file_name()) {
        if let Ok(real_parent) = std::fs::canonicalize(parent) {
            return real_parent.join(name);
        }
    }
    raw
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table(entries: &[(&str, &str, &str)]) -> HashMap<String, (String, String)> {
        entries
            .iter()
            .map(|(id, path, branch)| {
                ((*id).to_string(), ((*path).to_string(), (*branch).to_string()))
            })
            .collect()
    }

    fn facts(root: &str, branch: &str, common_dir: &str) -> RepoFacts {
        RepoFacts {
            root: root.into(),
            branch: branch.into(),
            common_dir: common_dir.into(),
        }
    }

    #[test]
    fn existing_workspace_is_reused_never_registered_twice() {
        let ws = table(&[
            ("main", "/x/repo", "main"),
            ("child", "/x/repo/.coflux/worktrees/child", "main"),
        ]);
        let owning = facts("/x/repo", "main", "/x/repo/.git");
        let target = facts(
            "/x/repo/.coflux/worktrees/child",
            "feat",
            "/x/repo/.git",
        );
        assert_eq!(
            decide(&ws, Some(&owning), Some(&target)),
            Locate::Existing {
                workspace_id: "child".into(),
                root: "/x/repo/.coflux/worktrees/child".into(),
                branch: "feat".into(),
            },
        );
        // ExitWorktree：目标就是归属工作区本身，同样是「命中既有」（中心那边即幂等无操作）
        assert_eq!(
            decide(&ws, Some(&owning), Some(&owning)),
            Locate::Existing {
                workspace_id: "main".into(),
                root: "/x/repo".into(),
                branch: "main".into(),
            },
        );
    }

    #[test]
    fn claude_self_made_worktree_under_the_main_workspace_is_registered() {
        // 102 的最长前缀会把它算进主工作区；这里必须按**相等**比，才登记得出来
        let ws = table(&[("main", "/x/repo", "main")]);
        let owning = facts("/x/repo", "main", "/x/repo/.git");
        let target = facts(
            "/x/repo/.claude/worktrees/fix-a",
            "worktree-fix-a",
            "/x/repo/.git",
        );
        assert_eq!(
            decide(&ws, Some(&owning), Some(&target)),
            Locate::Register {
                root: "/x/repo/.claude/worktrees/fix-a".into(),
                branch: "worktree-fix-a".into(),
            },
        );
        assert_eq!(
            workspace_at_root(&ws, "/x/repo/.claude/worktrees/fix-a"),
            None,
            "嵌在主工作区下的目录不是主工作区本身",
        );
        assert_eq!(workspace_at_root(&ws, "/x/repo").as_deref(), Some("main"));
        assert_eq!(workspace_at_root(&ws, "/x/repo2"), None, "不是前缀匹配");
    }

    #[test]
    fn another_repository_is_never_followed() {
        let ws = table(&[("main", "/x/repo", "main"), ("other", "/y/other", "main")]);
        let owning = facts("/x/repo", "main", "/x/repo/.git");
        // 即便目标已经是本设备上另一个登记过的工作区：不同仓库就是不跟随
        let target = facts("/y/other", "main", "/y/other/.git");
        match decide(&ws, Some(&owning), Some(&target)) {
            Locate::NotApplicable(reason) => assert!(reason.contains("另一个 git 仓库"), "{reason}"),
            other => panic!("跨仓库必须不适用: {other:?}"),
        }
    }

    #[test]
    fn non_git_target_and_directory_workspace_origin_are_not_applicable() {
        let ws = table(&[("main", "/x/repo", "main")]);
        let owning = facts("/x/repo", "main", "/x/repo/.git");
        match decide(&ws, Some(&owning), None) {
            Locate::NotApplicable(reason) => assert!(reason.contains("不是 git 仓库"), "{reason}"),
            other => panic!("非 git 目标必须不适用: {other:?}"),
        }
        // 终端开在目录工作区（无 project）：连归属仓库都没有，什么都不做
        let target = facts("/x/repo/.claude/worktrees/a", "worktree-a", "/x/repo/.git");
        match decide(&ws, None, Some(&target)) {
            Locate::NotApplicable(reason) => assert!(reason.contains("目录工作区"), "{reason}"),
            other => panic!("目录工作区起步必须不适用: {other:?}"),
        }
        match decide(&ws, None, None) {
            Locate::NotApplicable(_) => {}
            other => panic!("两边都没有 git 事实必须不适用: {other:?}"),
        }
    }

    #[test]
    fn paths_are_canonicalized_on_both_sides() {
        let base = std::env::temp_dir().join(format!("coflux-wtlocate-{}", std::process::id()));
        let real = base.join("real");
        let link = base.join("link");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&real).expect("建测试目录");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real, &link).expect("建符号链接");

        // 表里登记的是符号链接路径，git 报的是真实路径（macOS 的 /var → /private/var 同理）
        let ws = table(&[("linked", link.to_str().unwrap(), "main")]);
        assert_eq!(
            workspace_at_root(&ws, real.to_str().unwrap()).as_deref(),
            Some("linked"),
            "两边都要规范化",
        );
        // 反过来也成立
        let ws = table(&[("real", real.to_str().unwrap(), "main")]);
        assert_eq!(
            workspace_at_root(&ws, link.to_str().unwrap()).as_deref(),
            Some("real"),
        );
        // 同一仓库的两份写法（一份走符号链接）要判成同一个仓库
        let owning = facts(
            real.to_str().unwrap(),
            "main",
            real.join(".git").to_str().unwrap(),
        );
        let target = facts(
            link.to_str().unwrap(),
            "main",
            link.join(".git").to_str().unwrap(),
        );
        assert!(
            matches!(decide(&ws, Some(&owning), Some(&target)), Locate::Existing { .. }),
            "符号链接与真实路径是同一个仓库",
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn removed_directory_still_normalizes_through_its_parent() {
        // WorktreeRemove 时目录已经被 Claude Code 删掉：canonicalize 会失败，退回父目录规范化
        let base = std::env::temp_dir().join(format!("coflux-wtgone-{}", std::process::id()));
        let real = base.join("real");
        let link = base.join("link");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&real).expect("建测试目录");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real, &link).expect("建符号链接");

        let gone_real = real.join("worktrees-gone");
        let gone_link = link.join("worktrees-gone");
        let ws = table(&[("gone", gone_real.to_str().unwrap(), "main")]);
        assert_eq!(
            workspace_at_root(&ws, gone_link.to_str().unwrap()).as_deref(),
            Some("gone"),
            "目录已不在也要能按父目录规范化后认出来",
        );
        assert_eq!(
            normalize_display(gone_link.to_str().unwrap()),
            normalize_display(gone_real.to_str().unwrap()),
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn empty_and_unknown_roots_match_nothing() {
        let ws = table(&[("main", "/x/repo", "main"), ("blank", "", "")]);
        assert_eq!(workspace_at_root(&ws, ""), None);
        assert_eq!(workspace_at_root(&ws, "   "), None);
        assert_eq!(workspace_at_root(&ws, "/tmp/nowhere-at-all"), None);
        assert_eq!(workspace_at_root(&HashMap::new(), "/x/repo"), None);
    }
}
