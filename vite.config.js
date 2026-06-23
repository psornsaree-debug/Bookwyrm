import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base: "./" makes asset paths relative, so it works on GitHub Pages
// (https://USER.github.io/REPO/) without hardcoding the repo name.
export default defineConfig({
  base: "./",
  plugins: [react()],
});
