import { defineConfig } from "vite"
import react from "@vitejs/plugin-react-swc"
import fs from "fs"

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts: ["sp-mbp.local"],
    host: true,
    https: {
      key: fs.readFileSync("./.cert/key.pem"),
      cert: fs.readFileSync("./.cert/cert.pem"),
    },
  },
})
