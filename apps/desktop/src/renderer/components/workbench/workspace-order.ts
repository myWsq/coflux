import { isProjectArchived } from "@coflux/client";
import type { Project, Workspace } from "@coflux/protocol";

/**
 * The sidebar's tree order, in one place (plan 20261109-sidebar-current-section): the tree and the
 * 「当前」 section above it both read it, so a workspace keeps the same relative position in both.
 * Pure and free of `@/config` and React, so Node tests can import it.
 */

/** Visible projects in store order; archived ones (plan 20261030-project-archive) are not listed. */
export function visibleProjects(projects: readonly Project[]): Project[] {
  return projects.filter((project) => !isProjectArchived(project));
}

/** A project's workspaces: the main workspace first, then the rest by ascending `createdAt`. */
export function projectWorkspacesInOrder(workspaces: readonly Workspace[], projectId: string): Workspace[] {
  return workspaces
    .filter((workspace) => workspace.projectId === projectId)
    .sort((left, right) => (left.isMain === right.isMain ? left.createdAt - right.createdAt : left.isMain ? -1 : 1));
}

/** Every visible project with its workspaces, both in tree order. */
export function sidebarTree(projects: readonly Project[], workspaces: readonly Workspace[]): { project: Project; workspaces: Workspace[] }[] {
  return visibleProjects(projects).map((project) => ({ project, workspaces: projectWorkspacesInOrder(workspaces, project.id) }));
}
