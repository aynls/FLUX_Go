import FluxSidebar, { type SidebarProps } from "./flux/Sidebar";
import GptSidebar from "./gpt/Sidebar";
import QwenSidebar from "./qwen/Sidebar";
import FluxStage from "./flux/Stage";
import GptStage from "./gpt/Stage";
import ImageStage from "./shared/ImageStage";
import ImageSidebar from "./shared/ImageSidebar";
import type { StageProps } from "./shared/Stage";

const workspaces = {
  flux: { Sidebar: FluxSidebar, Stage: FluxStage },
  gpt: { Sidebar: GptSidebar, Stage: GptStage },
  qwen: { Sidebar: QwenSidebar, Stage: ImageStage },
  gemini: { Sidebar: ImageSidebar, Stage: ImageStage },
  seedream: { Sidebar: ImageSidebar, Stage: ImageStage },
  grok: { Sidebar: ImageSidebar, Stage: ImageStage },
};

export function WorkspaceSidebar(props: SidebarProps) {
  const Component = workspaces[props.draft.family].Sidebar;
  return <Component {...props} />;
}

export function WorkspaceStage(props: StageProps) {
  const Component = workspaces[props.draft.family].Stage;
  return <Component {...props} />;
}
