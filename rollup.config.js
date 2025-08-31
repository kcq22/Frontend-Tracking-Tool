import resolve from '@rollup/plugin-node-resolve'
import commonjs from '@rollup/plugin-commonjs'
import babel from '@rollup/plugin-babel'
import { terser } from 'rollup-plugin-terser'
import fs from 'fs'
import path from 'path'

const isProd = process.env.NODE_ENV === 'production'
const extensions = ['.js', '.mjs']

// 简易 inline 插件：把指定模块的源码从 node_modules 读取进 bundle
function inlineModule(modName) {
  return {
    name: `inline-${modName}`,
    async resolveId(source, importer) {
      if (source === modName) {
        const resolved = await this.resolve(modName, importer, { skipSelf: true })
        return resolved && resolved.id
      }
      return null
    },
    load(id) {
      if (!id) return null
      // 仅当路径包含 node_modules/<modName> 时读取
      const marker = path.join('node_modules', modName)
      if (id.includes(marker) || id.includes(`node_modules${path.sep}${modName}`)) {
        try {
          return fs.readFileSync(id, 'utf-8')
        } catch (e) {
          this.warn(`inlineModule: read failed ${id}: ${e.message || e}`)
        }
      }
      return null
    }
  }
}

const babelOptions = {
  babelHelpers: 'bundled',
  extensions,
  exclude: 'node_modules/**',
  presets: [
    [
      '@babel/preset-env',
      {
        targets: '> 0.25%, not dead',
        modules: false
      }
    ]
  ]
}

const basePlugins = [
  // 内联这些运行时依赖到 bundle
  inlineModule('@snowplow/browser-tracker'),
  inlineModule('@snowplow/browser-plugin-link-click-tracking'),
  inlineModule('uuid'),

  // 解析 node_modules、把 CJS 转 ESM
  resolve({ extensions, preferBuiltins: false }),
  commonjs({ include: /node_modules/ }),

  // Babel 转译（兼容旧环境）
  babel(babelOptions)
]

export default [
  // ESM (modern)
  {
    input: 'src/index.js',
    output: {
      file: 'dist/index.mjs',
      format: 'es',
      sourcemap: !isProd
    },
    plugins: [
      ...basePlugins,
      isProd && terser()
    ].filter(Boolean)
  },

  // CommonJS (Node / require)
  {
    input: 'src/index.js',
    output: {
      file: 'dist/index.cjs.js',
      format: 'cjs',
      sourcemap: !isProd,
      exports: 'named'
    },
    plugins: [
      ...basePlugins,
      isProd && terser()
    ].filter(Boolean)
  }
]
