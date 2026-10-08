import { useEffect, useRef } from "react";
import { m } from "../i18n";
export default function Modal({
  title,
  onClose,
  children,
  large = false,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  large?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={large ? "modal large" : "modal"}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      aria-label={title}
    >
      <div className="modal-heading">
        <h2>{title}</h2>
        <button onClick={onClose} aria-label={m.action_close()}>
          {m.action_close()}
        </button>
      </div>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}
