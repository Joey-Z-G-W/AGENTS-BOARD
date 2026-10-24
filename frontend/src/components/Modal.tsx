import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    element?.showModal();
    return () => { element?.close(); previous?.focus(); };
  }, []);
  return <dialog ref={dialog} className="detail-dialog" aria-labelledby="detail-heading" onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <div className="drawer-heading"><span>{title}</span><button className="icon-button" aria-label="关闭详情" onClick={onClose}><X size={20} /></button></div>
    {children}
  </dialog>;
}
