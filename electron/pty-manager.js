const os = require('os')
const pty = require('node-pty')

class PtyManager {
  constructor() {
    this.ptys = new Map()
  }

  create(id, cwd, cols, rows) {
    if (this.ptys.has(id)) {
      this.destroy(id)
    }

    const shell = process.env.SHELL || '/bin/zsh'
    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      },
    })

    this.ptys.set(id, ptyProcess)
    return ptyProcess
  }

  write(id, data) {
    const p = this.ptys.get(id)
    if (p) p.write(data)
  }

  resize(id, cols, rows) {
    const p = this.ptys.get(id)
    if (p) {
      try {
        p.resize(cols, rows)
      } catch (e) {
        // ignore resize errors on destroyed ptys
      }
    }
  }

  getCwd(id) {
    const p = this.ptys.get(id)
    if (p) {
      try {
        const { execSync } = require('child_process')
        const result = execSync(`lsof -a -p ${p.pid} -d cwd -Fn`, {
          encoding: 'utf-8',
        })
        const line = result.split('\n').find((l) => l.startsWith('n'))
        if (line && line.length > 1) {
          return line.slice(1).trim()
        }
        return process.env.HOME || '/Users'
      } catch {
        return process.env.HOME || '/Users'
      }
    }
    return process.env.HOME || '/Users'
  }

  destroy(id) {
    const p = this.ptys.get(id)
    if (p) {
      try {
        p.kill()
      } catch (e) {
        // already dead
      }
      this.ptys.delete(id)
    }
  }

  destroyAll() {
    for (const [id] of this.ptys) {
      this.destroy(id)
    }
  }
}

module.exports = { PtyManager }
