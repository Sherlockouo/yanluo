/* @refresh reload */
import { render } from "solid-js/web";
import { App } from "./App";
import "./styles/tailwind.css";

const root = document.getElementById("app");
if (!root) throw new Error("Root element #app not found");

render(() => <App />, root);
