import type { Draft } from "../lib/types";

const purposes = {
  reference: "",
  style: "visual style, colors and lighting",
  subject: "the subject's identity and appearance",
  composition: "composition and spatial arrangement",
  custom: "",
};
/** Roles are prompt instructions, never unsupported vendor API fields. */
export function referenceInstruction(d: Draft): string {
  const instruction =
    d.family === "flux"
      ? d.prompt.trim()
      : d.prompt
          .trim()
          .replace(
            /<ref_image_(\d+)>/g,
            (_, n: string) => `image ${Number(n) + 1}`,
          );
  if (!d.refs.length || !d.intent) return instruction;
  const tag = (i: number) =>
    d.family === "flux" ? `<ref_image_${i}>` : `image ${i + 1}`;
  const lines = [
    d.intent === "edit"
      ? `Edit ${tag(0)} as the primary image. Other images are references only.`
      : "Create a new image. The supplied images are references, not an image to edit.",
  ];
  d.refs.forEach((r, i) => {
    if (d.intent === "edit" && i === 0) return;
    const purpose = purposes[r.purpose ?? "reference"];
    if (purpose) lines.push(`Use ${tag(i)} as a reference for ${purpose}.`);
    if (r.note?.trim()) lines.push(`${tag(i)}: ${r.note.trim()}`);
  });
  return instruction + "\n\n" + lines.join("\n");
}
