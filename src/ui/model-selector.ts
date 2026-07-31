import type {
  ExtensionAPI,
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  type SelectItem,
  SelectList,
  type SelectListTheme,
  Spacer,
  Text,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  buildDefaultTierConfig,
  formatModelSpecWithThinking,
  listAvailableModelSpecs,
  listAvailableModels,
  loadModelTierConfig,
  saveModelTierConfig,
  splitModelSpecThinking,
  THINKING_LEVELS,
  type ModelThinkingLevel,
  type ModelTierConfig,
} from "@quintinshaw/pi-dynamic-workflows";

const DEFAULT_THINKING_CHOICE = "Default thinking";
const THINKING_CHOICES = [DEFAULT_THINKING_CHOICE, ...THINKING_LEVELS] as const;
const DEVFLOW_TIERS = ["small", "medium", "big"] as const;

interface ModelChoice {
  modelSpec: string;
  thinkingLevel?: ModelThinkingLevel;
}

export async function openDevflowModelSelector(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  onTiersSaved: (config: ModelTierConfig) => void,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/devflow-models requires TUI mode", "error");
    return;
  }
  await ctx.waitForIdle();

  let currentMain = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
  let config = loadModelTierConfig()
    ?? buildDefaultTierConfig(currentMain, listAvailableModels(ctx.modelRegistry));
  let dirty = false;

  while (true) {
    const central = currentMain ? `${currentMain}:${pi.getThinkingLevel()}` : "inherit";
    const options = [
      `central controller → ${central}`,
      ...DEVFLOW_TIERS.map((tier) => `${tier} tier → ${config.tiers[tier] ?? "inherit"}`),
      "Reset tiers to defaults",
      dirty ? "Save tiers and exit" : "Exit",
    ];
    const choice = await ctx.ui.select("Devflow model orchestration", options);
    if (!choice) return;

    if (choice.startsWith("central controller →")) {
      const selectedMain = await editCentralModel(pi, ctx, currentMain);
      if (selectedMain) currentMain = selectedMain;
      continue;
    }

    const tier = DEVFLOW_TIERS.find((name) => choice.startsWith(`${name} tier →`));
    if (tier) {
      const selected = await pickModel(ctx, tier, config.tiers[tier]);
      if (selected) {
        config = {
          ...config,
          tiers: {
            ...config.tiers,
            [tier]: formatModelSpecWithThinking(selected.modelSpec, selected.thinkingLevel),
          },
        };
        dirty = true;
      }
      continue;
    }

    if (choice === "Reset tiers to defaults") {
      const confirmed = await ctx.ui.confirm(
        "Reset Devflow model tiers",
        "Rebuild small, medium, and big from the available model list?",
      );
      if (confirmed) {
        config = buildDefaultTierConfig(currentMain, listAvailableModels(ctx.modelRegistry));
        dirty = true;
      }
      continue;
    }

    if (choice === "Save tiers and exit") {
      saveModelTierConfig(config);
      onTiersSaved(config);
      ctx.ui.notify("Devflow model tiers saved and applied.", "info");
      return;
    }
    if (choice === "Exit") return;
  }
}

async function editCentralModel(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  currentMain?: string,
): Promise<string | undefined> {
  const current = currentMain ? `${currentMain}:${pi.getThinkingLevel()}` : undefined;
  const selected = await pickModel(ctx, "central controller", current);
  if (!selected) return undefined;

  const slash = selected.modelSpec.indexOf("/");
  if (slash <= 0) {
    ctx.ui.notify(`Invalid model spec: ${selected.modelSpec}`, "error");
    return undefined;
  }
  const provider = selected.modelSpec.slice(0, slash);
  const modelId = selected.modelSpec.slice(slash + 1);
  const model = ctx.modelRegistry.find(provider, modelId);
  if (!model || !(await pi.setModel(model))) {
    ctx.ui.notify(`Model is unavailable or unauthenticated: ${selected.modelSpec}`, "error");
    return undefined;
  }
  if (selected.thinkingLevel) pi.setThinkingLevel(selected.thinkingLevel);
  ctx.ui.notify(
    `Central controller → ${selected.modelSpec}${selected.thinkingLevel ? `:${selected.thinkingLevel}` : ""}`,
    "info",
  );
  return selected.modelSpec;
}

async function pickModel(
  ctx: ExtensionCommandContext,
  role: string,
  current?: string,
): Promise<ModelChoice | null> {
  const available = listAvailableModelSpecs(ctx.modelRegistry);
  if (available.length === 0) {
    ctx.ui.notify("No authenticated models are available.", "error");
    return null;
  }
  const currentParts = splitModelSpecThinking(current, available);
  const items: SelectItem[] = available.map((spec) => ({ value: spec, label: spec }));
  const selectedModel = await ctx.ui.custom<string | null>((tui: TUI, theme: Theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(new Text(
      theme.fg("accent", `Pick a model for ${role}${current ? ` (current: ${current})` : ""}`),
      1,
      0,
    ));
    container.addChild(new Spacer(1));
    const selectTheme: SelectListTheme = {
      selectedPrefix: (text: string) => theme.bg("selectedBg", theme.fg("accent", text)),
      selectedText: (text: string) => theme.bg("selectedBg", theme.bold(text)),
      description: (text: string) => theme.fg("muted", text),
      scrollInfo: (text: string) => theme.fg("dim", text),
      noMatch: (text: string) => theme.fg("warning", text),
    };
    const list = new SelectList(items, 12, selectTheme);
    if (currentParts.modelSpec) {
      const index = items.findIndex((item) => item.value === currentParts.modelSpec);
      if (index >= 0) list.setSelectedIndex(index);
    }
    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done(null);
    container.addChild(list);
    container.addChild(new Spacer(1));
    container.addChild(new Text(
      theme.fg("dim", "↑↓ navigate · enter select · esc cancel · thinking is chosen next"),
      1,
      0,
    ));
    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        list.handleInput(data);
        tui.requestRender();
      },
    };
  });
  if (!selectedModel) return null;

  const thinkingChoice = await ctx.ui.select(
    `Thinking for ${role}`,
    THINKING_CHOICES.map(String),
  );
  if (!thinkingChoice) return null;
  const thinkingLevel = THINKING_LEVELS.find((level) => level === thinkingChoice);
  return {
    modelSpec: selectedModel,
    ...(thinkingLevel ? { thinkingLevel } : {}),
  };
}
