import os from "node:os"
import path from "node:path"

const home = os.homedir()
const xdgConfig = process.env["XDG_CONFIG_HOME"] ?? path.join(home, ".config")

export const Global = {
  Path: {
    config: process.env["KINEX_CONFIG_DIR"] ?? path.join(xdgConfig, "kinex"),
  },
}
