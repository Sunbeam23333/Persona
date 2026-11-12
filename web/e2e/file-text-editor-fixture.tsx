// Development-only browser fixture. Its runner intercepts every API request; no hub or disk file is used.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { initI18n } from "../src/i18n";
import { applyLook } from "../src/ui/look";
import "../src/styles.css";

await initI18n("en");
applyLook();
document.documentElement.classList.toggle("dark", localStorage.getItem("persona.theme") === "dark");
const [{ FileView }, { connect }, { Button, Toasts }] = await Promise.all([
  import("../src/views/session/files/FileView"), import("../src/lib/store"), import("../src/ui/atoms"),
]);
connect();
function Fixture() {
  const [open, setOpen] = useState(true);
  return <main className="flex h-dvh min-w-0 flex-col bg-surface text-ink">
    {open ? <FileView mid="example-computer" path="/workspace/example.ts" cwd="/workspace"
      onClose={() => setOpen(false)} onOpenPath={() => {}} />
      : <div className="p-3"><Button onClick={() => setOpen(true)}>Reopen example file</Button></div>}
    <Toasts />
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
