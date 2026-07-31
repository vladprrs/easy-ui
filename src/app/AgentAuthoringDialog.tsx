import type { ReactElement } from "react";
import { Modal } from "./Modal";
import { pillPrimary } from "./chrome";
import { agentAuthoring } from "./strings/agentAuthoring";

/** Одна и та же инструкция запуска агента для всех продуктовых CTA. */
export function AgentAuthoringDialog({ onClose }: { onClose: () => void }): ReactElement {
  return <Modal
    title={agentAuthoring.dialogTitle}
    onClose={onClose}
    footer={<button type="button" className={pillPrimary} onClick={onClose}>{agentAuthoring.understood}</button>}
  >
    <p className="mt-3 text-sm leading-6 text-eui-slate-500">{agentAuthoring.dialogBody}</p>
  </Modal>;
}
