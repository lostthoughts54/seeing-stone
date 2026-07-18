import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Seeing Stone player shell", () => {
  it("uses a dedicated inert native viewport with sibling controls", async () => {
    const html = await readFile("src/renderer/index.html", "utf8");
    const player = html.slice(html.indexOf('<section id="playerView"'), html.indexOf('<div id="downloadsScrim"'));
    expect(player).toContain('id="playerViewport"');
    expect(player).not.toMatch(/<video\b/i);
    expect(player.indexOf('id="playerViewport"')).toBeLessThan(player.indexOf('id="playerControls"'));
    expect(player).toContain('id="playerCenter"');
    expect(player).toContain('aria-label="Native video surface"');
    expect(player).toContain('aria-label="Playback controls"');
  });

  it("provides the required controls and contextual Session Panel without enabling chat", async () => {
    const html = await readFile("src/renderer/index.html", "utf8");
    for (const id of [
      "playerTimeline",
      "playerVolume",
      "playerPlayPauseButton",
      "playerBack10Button",
      "playerForward10Button",
      "playerRateSelect",
      "playerAudioSelect",
      "playerSubtitleSelect",
      "playerFullscreenButton",
      "playerNextButton",
      "playerSettingsMenu",
      "playerSettingsRateSelect",
      "playerSettingsAudioSelect",
      "playerSettingsSubtitleSelect",
      "sessionPanel",
      "sessionSoloTab",
      "sessionWatchpartyTab",
      "sessionChatTab",
    ]) expect(html).toContain(`id="${id}"`);
    expect(html).toMatch(/id="sessionChatTab"[^>]*aria-disabled="true"[^>]*disabled/);
    expect(html).toMatch(/id="playerSettingsButton"[^>]*aria-controls="playerSettingsMenu"[^>]*aria-expanded="false"/);
    expect(html).toMatch(/id="openSessionPanelButton"[^>]*aria-controls="sessionPanel"[^>]*aria-expanded="true"/);
  });

  it("bundles local fonts, responsive layouts, reduced motion, and visible focus", async () => {
    const styles = await readFile("src/renderer/styles.css", "utf8");
    expect(styles).toContain('./assets/fonts/InterVariable.woff2');
    expect(styles).toContain('./assets/fonts/Spectral-Regular.ttf');
    expect(styles).toContain('@media (max-width: 1120px)');
    expect(styles).toContain('@media (max-width: 880px)');
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
    expect(styles).toMatch(/button:focus-visible,[\s\S]*?outline:\s*2px solid var\(--accent\)/);
  });

  it("exposes licenses from the generated inventory and removes temporary branding", async () => {
    const [html, renderer, security] = await Promise.all([
      readFile("src/renderer/index.html", "utf8"),
      readFile("src/renderer/app.ts", "utf8"),
      readFile("src/main/electronSecurity.ts", "utf8"),
    ]);
    expect(html).toContain('id="licensesPanel"');
    expect(renderer).toContain("window.jellyfin.licenses.list()");
    expect(`${html}\n${renderer}`).not.toContain("LocalFirst");
    expect(security).toContain('".woff2": "font/woff2"');
    expect(security).toContain('".ttf": "font/ttf"');
  });

  it("keeps controls visible whenever focus is inside them", async () => {
    const styles = await readFile("src/renderer/styles.css", "utf8");
    const renderer = await readFile("src/renderer/app.ts", "utf8");
    expect(styles).toContain('.player-controls:not(:focus-within)');
    expect(renderer).toContain('!playerControls.contains(document.activeElement)');
    expect(renderer).toContain('playerView.addEventListener("focusin", markPlayerActivity)');
  });

  it("keeps compact playback options reachable through the real settings surface", async () => {
    const [html, styles, renderer] = await Promise.all([
      readFile("src/renderer/index.html", "utf8"),
      readFile("src/renderer/styles.css", "utf8"),
      readFile("src/renderer/app.ts", "utf8"),
    ]);
    expect(html).toContain('role="dialog" aria-labelledby="playerSettingsTitle"');
    expect(html).toContain("Open playback diagnostics");
    expect(styles).not.toContain(".compact-control:nth-of-type(2)");
    expect(styles).toContain(".player-settings-grid { grid-template-columns: 1fr; }");
    expect(renderer).toContain("playerSettingsRateSelect.addEventListener");
    expect(renderer).toContain("playerSettingsAudioSelect.addEventListener");
    expect(renderer).toContain("playerSettingsSubtitleSelect.addEventListener");
    expect(renderer).toContain("closePlayerSettings()");
  });

  it("does not rebuild dynamic panel content for every position tick", async () => {
    const renderer = await readFile("src/renderer/app.ts", "utf8");
    expect(renderer).toContain("let playerStructuralRenderKey");
    expect(renderer).toContain("if (forceStructure || structureKey !== playerStructuralRenderKey)");
    expect(renderer).toContain("const advancedOpen = Boolean");
    expect(renderer).toContain("const activeAction = activeElement?.dataset.sessionAction");
  });

  it("preserves a visible safe terminal state after forced player termination", async () => {
    const renderer = await readFile("src/renderer/app.ts", "utf8");
    expect(renderer).toContain("const lostActivePlayback");
    expect(renderer).toContain('playback.phase === "disconnected"');
    expect(renderer).toContain("void syncPlayerViewport(false)");
    expect(renderer).not.toContain('playerView.classList.add("is-hidden");\n  document.body.classList.remove("is-playing");\n  void syncPlayerViewport(false);\n  state.lastFocusElement?.focus?.();');
  });

  it("reconciles the native host on player scrolling and hides it outside the scrollport", async () => {
    const renderer = await readFile("src/renderer/app.ts", "utf8");
    expect(renderer).toContain('playerCenter.addEventListener("scroll", schedulePlayerViewport');
    expect(renderer).toContain("const fullyInsideScrollport = bounds.left >= scrollport.left");
    expect(renderer).toContain("visible: visible && fullyInsideScrollport");
  });

  it("keeps essential text and state colors at readable contrast", async () => {
    const styles = await readFile("src/renderer/styles.css", "utf8");
    const token = (name: string): string => {
      const match = styles.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"));
      if (!match) throw new Error(`Missing color token ${name}`);
      return match[1];
    };
    const channel = (value: number): number => {
      const normalized = value / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (hex: string): number => {
      const value = Number.parseInt(hex.slice(1), 16);
      return 0.2126 * channel((value >> 16) & 255) + 0.7152 * channel((value >> 8) & 255) + 0.0722 * channel(value & 255);
    };
    const ratio = (foreground: string, background: string): number => {
      const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
      return (values[0] + 0.05) / (values[1] + 0.05);
    };
    const background = token("ss-obsidian");
    for (const foreground of ["text", "muted", "ss-lavender", "ss-blue", "ss-green", "ss-amber", "ss-rose"]) {
      expect(ratio(token(foreground), background), `${foreground} against ${background}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
