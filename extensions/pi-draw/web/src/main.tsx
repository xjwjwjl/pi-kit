import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import "./styles.css";
import "@excalidraw/excalidraw/index.css";

createRoot(document.getElementById("root") as HTMLElement).render(
	<React.StrictMode>
		<App />
	</React.StrictMode>,
);
