import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf-8"));
const outFileName = `${pkg.name}.bundle.cjs`;

/** @type {import("@rspack/core").Configuration} */
export default {
  mode: "production",
  entry: resolve(rootDir, "src/index.ts"),
  target: "web",
  devtool: false,
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        exclude: /node_modules/,
        loader: "builtin:swc-loader",
        options: {
          jsc: {
            parser: { syntax: "typescript" },
            target: "es2019"
          }
        }
      }
    ]
  },
  resolve: { extensions: [".ts", ".tsx", ".mjs", ".js", ".json"] },
  output: {
    path: resolve(rootDir, "dist"),
    filename: outFileName,
    library: { type: "commonjs2" }
  },
  optimization: {
    minimize: true,
    usedExports: true,
    sideEffects: true,
    concatenateModules: true
  }
};
