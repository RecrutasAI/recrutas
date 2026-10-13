import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { initAnalytics } from "./lib/analytics";
import { rememberSignupCode } from "./lib/signup-code";

initAnalytics();
rememberSignupCode();

createRoot(document.getElementById("root")!).render(
    <App />
);