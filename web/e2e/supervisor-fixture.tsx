// Real extension page renderer with the browser runner's synthetic, intercepted hub responses only.
import { createRoot } from "react-dom/client";
import { initI18n } from "../src/i18n";
import { applyLook } from "../src/ui/look";
import "../src/styles.css";

await initI18n("en");
applyLook();
document.documentElement.classList.toggle("dark", localStorage.getItem("persona.theme") === "dark");
const [{ ExtensionNavPage }, { connect }, { Toasts }] = await Promise.all([
  import("../src/views/extensions/ExtensionSlots"), import("../src/lib/store"), import("../src/ui/atoms"),
]);
connect();
createRoot(document.getElementById("root")!).render(<main className="h-dvh min-w-0 bg-inset text-ink">
  <ExtensionNavPage extension="dsh-supervisor" ui="supervisor" onToggleSidebar={() => {}} /><Toasts />
</main>);
