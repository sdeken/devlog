/**
 * Node types: kinds of canvas that extensions give meaning to (the time
 * extension's "task"). The registry comes from the extensions that are
 * allowed; a canvas whose type no extension provides shows as a plain canvas.
 */
import { createContext, useContext } from "react";
import { TASK_TYPE, nodeTypeName } from "@devlog/core";
import type { CanvasMeta } from "@shared/types";
import type { ExtensionInfo } from "@shared/extensions";

export interface NodeTypeInfo {
  /** "<extension id>/<type id>". */
  type: string;
  label: string;
  icon: string;
  placeholder?: string;
  /** The extension that provides it (its devlog.json key); absent for the app's own. */
  extensionKey?: string;
}

export const PLAIN_ICON = "▤";

/** Until the time extension provides it, the app keeps the task type itself. */
const BUILTIN_TYPES: NodeTypeInfo[] = [
  { type: TASK_TYPE, label: "Task", icon: "◉" },
];

export function buildNodeTypes(
  extensions: ExtensionInfo[],
): Map<string, NodeTypeInfo> {
  const out = new Map<string, NodeTypeInfo>();
  for (const t of BUILTIN_TYPES) out.set(t.type, t);
  for (const e of extensions)
    for (const t of e.nodeTypes) {
      const type = nodeTypeName(e.id, t.id);
      out.set(type, {
        type,
        label: t.label,
        icon: t.icon ?? "◆",
        ...(t.placeholder ? { placeholder: t.placeholder } : {}),
        extensionKey: e.key,
      });
    }
  return out;
}

export const NodeTypesContext = createContext<Map<string, NodeTypeInfo>>(
  buildNodeTypes([]),
);

export function useNodeTypes(): Map<string, NodeTypeInfo> {
  return useContext(NodeTypesContext);
}

/** A canvas's type, if something provides it. */
export function typeOf(
  types: Map<string, NodeTypeInfo>,
  c: Pick<CanvasMeta, "type">,
): NodeTypeInfo | undefined {
  return c.type ? types.get(c.type) : undefined;
}

export function canvasIcon(
  types: Map<string, NodeTypeInfo>,
  c: Pick<CanvasMeta, "type">,
): string {
  return typeOf(types, c)?.icon ?? PLAIN_ICON;
}
