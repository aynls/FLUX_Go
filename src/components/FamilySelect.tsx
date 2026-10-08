import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CaretDown, Check } from "@phosphor-icons/react";
import { families } from "../models/catalog";
import type { FamilyId } from "../lib/types";
import { m } from "../i18n";

const icons: Record<FamilyId, string> = {
  flux: "/flux.png", gpt: "/openai.png", qwen: "/qwen-color.png",
  gemini: "/nano-banana.png", seedream: "/seedream.png", grok: "/grok.svg",
};
function Icon({ family }: { family: FamilyId }) {
  return <img className={"family-icon" + (["flux", "gpt", "grok"].includes(family) ? " monochrome" : "")} src={icons[family]} alt="" aria-hidden="true" />;
}

export default function FamilySelect({ value, disabled, onChange }: {
  value: FamilyId; disabled: boolean; onChange: (value: FamilyId) => void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0, maxHeight: 320 });
  const selected = families.findIndex((family) => family.id === value);
  const show = () => { setActive(selected); setOpen(true); };
  const choose = (index: number) => {
    setOpen(false);
    onChange(families[index].id);
    trigger.current?.focus();
  };
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = trigger.current!.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom - 8;
      const height = Math.min(menu.current?.scrollHeight || 260, Math.max(below, rect.top - 8));
      setPosition({ left: rect.left, width: rect.width, top: below >= height ? rect.bottom + 4 : rect.top - height - 4, maxHeight: height });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => { window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => {
    (menu.current?.children[active] as HTMLElement | undefined)?.scrollIntoView?.({ block: "nearest" });
  }, [active, open, id]);
  return <div className="model-family-control">
    <button ref={trigger} type="button" className="family-select-trigger" role="combobox" aria-label={m.family_label()} value={value}
      aria-expanded={open} aria-haspopup="listbox" aria-controls={open ? id : undefined}
      aria-activedescendant={open ? `${id}-${active}` : undefined} disabled={disabled}
      onClick={() => open ? setOpen(false) : show()}
      onBlur={(event) => { if (!menu.current?.contains(event.relatedTarget as Node)) setOpen(false); }}
      onKeyDown={(event) => {
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          if (!open) show();
          else setActive(index => event.key === "Home" ? 0 : event.key === "End" ? families.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + families.length) % families.length);
        } else if (event.key === "Enter" || event.key === " ") {
          event.preventDefault(); open ? choose(active) : show();
        } else if (event.key === "Escape") { event.preventDefault(); setOpen(false); }
        else if (event.key === "Tab") setOpen(false);
      }}>
      <Icon family={value} /><span>{families[selected].label}</span><CaretDown size={16} />
    </button>
    {open && createPortal(<div ref={menu} id={id} role="listbox" aria-label={m.family_label()} className="family-select-menu" style={position}>
      {families.map((family, index) => <button type="button" key={family.id} id={`${id}-${index}`} role="option" aria-selected={family.id === value}
        className={active === index ? "highlighted" : ""} tabIndex={-1}
        onPointerDown={event => event.preventDefault()} onPointerMove={() => setActive(index)} onClick={() => choose(index)}>
        <Icon family={family.id} /><span>{family.label}</span>{family.id === value && <Check size={16} />}
      </button>)}
    </div>, document.body)}
  </div>;
}
