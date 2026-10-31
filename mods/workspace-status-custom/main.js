import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, theme, run, window, hc, exec, machines, notify } from "herdr";

function parseProcOutput(output, prevCpu) {
  if (!output || typeof output !== "string") return null;
  const parts = output.split("---");
  if (parts.length < 3) return null;

  const loadPart = parts[0].trim();
  const statPart = parts[1].trim();
  const memPart = parts[2].trim();

  // 1. 1-minute load average
  const loadMatch = loadPart.match(/^([\d.]+)/);
  const load1m = loadMatch ? parseFloat(loadMatch[1]) : 0;

  // 2. CPU percentage calculation from /proc/stat
  let cpuPercent = null;
  let nextCpu = null;
  const firstLine = statPart.split("\n")[0];
  const cpuFields = firstLine.trim().split(/\s+/).slice(1).map(Number);
  if (cpuFields.length >= 4) {
    const user = cpuFields[0] || 0;
    const nice = cpuFields[1] || 0;
    const system = cpuFields[2] || 0;
    const idle = cpuFields[3] || 0;
    const iowait = cpuFields[4] || 0;
    const irq = cpuFields[5] || 0;
    const softirq = cpuFields[6] || 0;
    const steal = cpuFields[7] || 0;

    const idleTime = idle + iowait;
    const busyTime = user + nice + system + irq + softirq + steal;
    const totalTime = idleTime + busyTime;

    nextCpu = { idle: idleTime, busy: busyTime, total: totalTime };

    if (prevCpu && prevCpu.total && totalTime > prevCpu.total) {
      const deltaTotal = totalTime - prevCpu.total;
      const deltaBusy = busyTime - prevCpu.busy;
      cpuPercent = deltaTotal > 0 ? Math.max(0, Math.min(100, Math.round((100 * deltaBusy) / deltaTotal))) : 0;
    }
  }

  // 3. RAM info from /proc/meminfo
  let memTotalKb = 0;
  let memAvailKb = 0;
  const totalMatch = memPart.match(/MemTotal:\s+(\d+)\s+kB/i);
  const availMatch = memPart.match(/MemAvailable:\s+(\d+)\s+kB/i);
  if (totalMatch) memTotalKb = parseInt(totalMatch[1], 10);
  if (availMatch) {
    memAvailKb = parseInt(availMatch[1], 10);
  } else {
    const freeMatch = memPart.match(/MemFree:\s+(\d+)\s+kB/i);
    const bufMatch = memPart.match(/Buffers:\s+(\d+)\s+kB/i);
    const cacheMatch = memPart.match(/Cached:\s+(\d+)\s+kB/i);
    if (freeMatch) {
      memAvailKb = parseInt(freeMatch[1], 10) +
        (bufMatch ? parseInt(bufMatch[1], 10) : 0) +
        (cacheMatch ? parseInt(cacheMatch[1], 10) : 0);
    }
  }

  let memPercent = 0;
  let memUsedGb = "0";
  let memTotalGb = "0";
  if (memTotalKb > 0) {
    const memUsedKb = Math.max(0, memTotalKb - memAvailKb);
    memPercent = Math.round((memUsedKb / memTotalKb) * 100);
    memUsedGb = (memUsedKb / 1048576).toFixed(1);
    memTotalGb = (memTotalKb / 1048576).toFixed(0);
  }

  return {
    cpuPercent,
    load1m,
    memPercent,
    memUsedGb,
    memTotalGb,
    nextCpu,
  };
}

export default class WorkspaceStatusCustom extends View {
  init(_props, cx) {
    this.stats = {};
    this.prevCpu = {};
    this.cachedMachines = [];
    this.lastMachineLs = 0;
    this.pollingMachine = {};
    this.activeTimers = new Set();

    // Start polling
    this.refreshAll(cx, true);

    // Regular interval: poll every 6s (ultra-low overhead)
    this.mainTimer = cx.timer.every(6000, (cx) => this.refreshAll(cx, false));
  }

  close(_cx) {
    if (this.mainTimer && !this.mainTimer.is_done()) {
      this.mainTimer.cancel();
    }
    for (const t of this.activeTimers) {
      if (t && !t.is_done()) {
        t.cancel();
      }
    }
    this.activeTimers.clear();
  }

  scheduleTimer(ms, handler, cx) {
    const task = cx.timer.after(ms, (cx) => {
      this.activeTimers.delete(task);
      handler(cx);
    });
    this.activeTimers.add(task);
    return task;
  }

  execWithTimeout(cmd, args, options, timeoutMs, cx) {
    let timerTask = null;
    let settled = false;

    return new Promise((resolve, reject) => {
      timerTask = this.scheduleTimer(timeoutMs, () => {
        if (!settled) {
          settled = true;
          reject(new Error("Timeout"));
        }
      }, cx);

      exec(cmd, args, options)
        .then((res) => {
          if (!settled) {
            settled = true;
            if (timerTask && !timerTask.is_done()) {
              timerTask.cancel();
              this.activeTimers.delete(timerTask);
            }
            resolve(res);
          }
        })
        .catch((err) => {
          if (!settled) {
            settled = true;
            if (timerTask && !timerTask.is_done()) {
              timerTask.cancel();
              this.activeTimers.delete(timerTask);
            }
            reject(err);
          }
        });
    });
  }

  async refreshMachinesList(cx, force = false) {
    const now = Date.now();
    const liveMachines = machines().filter((m) => m.name !== null);

    // Fast check: if cached machines match live machine names and not expired, skip hc CLI invocation
    const cachedNames = this.cachedMachines.map((m) => m.name).sort().join(",");
    const liveNames = liveMachines.map((m) => m.name).sort().join(",");

    if (!force && this.cachedMachines.length > 0 && cachedNames === liveNames && now - this.lastMachineLs < 60000) {
      return this.cachedMachines;
    }

    try {
      const r = await hc(["machine", "ls", "--json"]);
      if (r.code === 0 && r.stdout) {
        const data = JSON.parse(r.stdout);
        const list = (data.machines ?? []).filter((m) => !m.temporary);
        if (list.length > 0) {
          this.cachedMachines = list;
          this.lastMachineLs = now;
          return list;
        }
      }
    } catch {}

    // Fallback if hc ls fails
    if (this.cachedMachines.length === 0) {
      this.cachedMachines = liveMachines.map((m) => ({
        name: m.name,
        target: m.name,
        state: m.layout === "unavailable" ? "disconnected" : "connected",
      }));
      this.lastMachineLs = now;
    }

    return this.cachedMachines;
  }

  refreshAll(cx, forceList = false) {
    cx.spawn(async (cx) => {
      const list = await this.refreshMachinesList(cx, forceList);
      if (!list || list.length === 0) return;

      // Poll each remote machine concurrently and independently
      for (const m of list) {
        this.pollMachine(m, cx);
      }
    });
  }

  async pollMachine(m, cx, isFastFollowup = false) {
    const name = m.name;
    if (!name || this.pollingMachine[name]) return;
    this.pollingMachine[name] = true;
    cx.notify();

    try {
      if (m.state === "disconnected") {
        this.markOffline(name, cx);
        return;
      }

      // Single lightweight procfs read with a strict 3.5s timeout
      const res = await this.execWithTimeout(
        "sh",
        ["-c", "cat /proc/loadavg; echo '---'; head -n 1 /proc/stat; echo '---'; head -n 5 /proc/meminfo"],
        { on: name },
        3500,
        cx
      );

      if (res && res.code === 0 && res.stdout) {
        const parsed = parseProcOutput(res.stdout, this.prevCpu[name]);
        if (parsed) {
          const isFirstSample = !this.prevCpu[name];
          if (parsed.nextCpu) {
            this.prevCpu[name] = parsed.nextCpu;
          }

          // If this was the first sample, trigger a quick 600ms follow-up for real CPU delta
          if (isFirstSample && parsed.cpuPercent === null) {
            this.scheduleTimer(600, (cx) => this.pollMachine(m, cx, true), cx);
          }

          const next = {
            online: true,
            cpuPercent: parsed.cpuPercent,
            load1m: parsed.load1m,
            memPercent: parsed.memPercent,
            memUsedGb: parsed.memUsedGb,
            memTotalGb: parsed.memTotalGb,
          };

          this.stats[name] = next;
          cx.notify();
        }
      } else {
        this.markOffline(name, cx);
      }
    } catch {
      this.markOffline(name, cx);
    } finally {
      this.pollingMachine[name] = false;
      cx.notify();
    }
  }

  markOffline(name, cx) {
    const prev = this.stats[name];
    if (!prev || prev.online !== false) {
      this.stats[name] = { online: false };
      cx.notify();
    }
  }

  render() {
    const t = theme();
    const space = spaces().find((s) => s.active);
    const list = agents();
    const needs = list.filter((a) => a.status === "blocked").length;
    const label = (icon, text) =>
      h_flex()
        .gap(6)
        .items_center()
        .child(svg(`mods/workspace-chrome/${icon}.svg`).size(13))
        .child(text);

    const remotes = this.cachedMachines.filter((m) => m && m.name);

    return h_flex()
      .size_full()
      .px(14)
      .gap(16)
      .items_center()
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(11.8)
      .text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), (el) => el.child(label("branch", space.branch)))
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(div().size(6).rounded(3).bg(t.dim))
          .child(`${list.length} agents`)
          .when(needs > 0, (el) =>
            el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))
          )
      )
      .when(remotes.length > 0, (el) =>
        el
          .child(div().h(12).w(1).bg(t.border))
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .children(
                remotes.map((m) => {
                  const stat = this.stats[m.name];
                  const isOnline = stat && stat.online;
                  const isPolling = Boolean(this.pollingMachine[m.name]);
                  const isCritical = isOnline && (stat.cpuPercent > 85 || stat.memPercent > 90);
                  const isWarn = isOnline && (stat.cpuPercent > 65 || stat.memPercent > 80);
                  const dotColor = !isOnline
                    ? t.dim
                    : isCritical
                    ? t.blocked
                    : isWarn
                    ? (t.working || t.accent)
                    : (t.done || t.accent);

                  const statColor = !isOnline
                    ? t.dim
                    : isCritical
                    ? t.blocked
                    : isWarn
                    ? (t.working || t.foreground)
                    : t.muted;

                  const displayName = m.target || m.name;
                  const cpuText = stat?.cpuPercent != null ? `CPU ${stat.cpuPercent}%` : "CPU …";

                  return h_flex()
                    .id(`remote-${m.name}`)
                    .gap(6)
                    .items_center()
                    .px(6)
                    .py(2)
                    .rounded(4)
                    .hover((s) => s.bg(t.raised))
                    .cursor_pointer()
                    .tooltip(
                      isOnline
                        ? `${displayName}${m.name !== displayName ? ` (${m.name})` : ""}: ${cpuText} (load ${stat.load1m}) · RAM ${stat.memUsedGb}/${stat.memTotalGb} GB (${stat.memPercent}%) — Tıkla: Yenile`
                        : `${displayName}: çevrimdışı — Tıkla: Tekrar dene`
                    )
                    .on_click((_e, cx) => {
                      if (!isOnline) {
                        this.refreshMachinesList(cx, true).then(() => this.pollMachine(m, cx));
                      } else {
                        this.pollMachine(m, cx);
                      }
                    })
                    .child(div().size(6).rounded(3).bg(dotColor))
                    .child(div().text_color(t.foreground).child(displayName))
                    .when(isPolling, (item) =>
                      item.child(
                        svg("mods/workspace-status-custom/spinner.svg")
                          .size(11)
                          .flex_none()
                          .text_color(t.working || t.accent)
                          .spin(900)
                      )
                    )
                    .when(isOnline, (item) =>
                      item
                        .child(div().text_color(statColor).child(cpuText))
                        .child(div().text_color(t.dim).child("·"))
                        .child(div().text_color(statColor).child(`RAM ${stat.memPercent}%`))
                    )
                    .when(!isOnline, (item) =>
                      item.child(div().text_color(t.dim).child("offline"))
                    );
                })
              )
          )
      )
      .child(div().flex_1())
      .child(
        div()
          .id("palette")
          .text_color(t.dim)
          .on_click(() => run("app.palette"))
          .child(
            `${window()?.platform === "macos" ? "⌘" : "Ctrl"} Shift P  commands`
          )
      );
  }
}
