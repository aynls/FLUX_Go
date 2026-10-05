import { useEffect, useRef } from "react";
export default function Modal({ title, onClose, children, large = false }: { title: string; onClose: () => void; children: React.ReactNode; large?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); return () => ref.current?.close(); }, []);
  return <dialog ref={ref} className={large ? "modal large" : "modal"} onCancel={onClose} aria-label={title}>
    <div className="modal-heading"><h2>{title}</h2><button onClick={onClose} aria-label="关闭">关闭</button></div>{children}
  </dialog>;
}
