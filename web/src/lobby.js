import qrcode from "../vendor/qrcode-generator.js";
import { createPeer, parseSignalCode, signalLink } from "./peer.js";

const pendingReplies = typeof BroadcastChannel === "function" ? new BroadcastChannel("wargame-pairing-v1") : null;

export function openLobby({ openDialog, factionsForScenario, invite, saved, resumeOnly, regionalScenario, onMatch, onMessage, onDisconnect }) {
  openDialog("Direct connection", "Multiplayer", `
    <p class="section-help">Both players plan privately. When both lock their orders, the year resolves together. Pair on the same Wi-Fi for best results.</p>
    <div id="host-choice" class="peer-choices">
      <label>Match mode<select id="match-mode"><option value="versus">Head-to-head</option><option value="alliance">Diplomacy</option><option value="coop">Co-op against AI</option></select></label>
      <label>Scenario<select id="match-scenario"><option value="">Classic board</option><option value="${regionalScenario}">Regional Coalitions (fictional)</option></select></label>
      <label>Host faction<select id="host-faction"></select></label>
      <label>Guest faction<select id="guest-faction"></select></label>
      <button id="create-invite" class="primary-button" type="button" ${resumeOnly ? "hidden" : ""}>Create invite</button>
      ${saved ? '<button id="resume-invite" class="secondary-button" type="button">Reconnect saved host match</button>' : ""}
    </div>
    <form id="pair-form" class="dialog-form">
      <label><span id="pair-label">Invite link</span><textarea id="pair-input" maxlength="4500" rows="2" autocapitalize="off" spellcheck="false" required></textarea></label>
      <button id="pair-submit" class="secondary-button" type="submit">Join match</button>
    </form>
    <p id="pair-status" class="section-help" role="status"></p>
    <div id="pair-output" hidden>
      <div id="pair-qr"></div>
      <label><span id="pair-output-label"></span><textarea id="pair-link" readonly rows="2"></textarea></label>
      <button id="copy-pair-link" class="secondary-button" type="button">Copy link</button>
    </div>`, (root) => {
    const get = (name) => root.querySelector(`#${name}`);
    const dialog = root.closest("dialog");
    const status = get("pair-status");
    const input = get("pair-input");
    const form = get("pair-form");
    const create = get("create-invite");
    const resume = get("resume-invite");
    const submit = get("pair-submit");
    const hostChoice = get("host-choice");
    const output = get("pair-output");
    let peer;
    let transferred = false;
    let acceptingReply = false;
    let closed = false;
    const scenario = get("match-scenario");
    function populateFactions() {
      const options = factionsForScenario(scenario.value || null).map(({ id, label }) => `<option value="${id}">${label}</option>`).join("");
      get("host-faction").innerHTML = get("guest-faction").innerHTML = options;
      get("guest-faction").selectedIndex = 1;
    }
    populateFactions();
    scenario.addEventListener("change", populateFactions);
    if (resumeOnly) {
      for (const label of hostChoice.querySelectorAll("label")) label.hidden = true;
      hostChoice.hidden = !saved;
    }

    function stop() {
      if (closed) return;
      closed = true;
      pendingReplies?.removeEventListener("message", receiveReply);
      dialog.removeEventListener("close", stop);
      if (!transferred) peer?.close();
    }

    function report(error) {
      if (!closed) status.textContent = error.message || "The connection could not be created.";
    }

    function displayLink(code, title) {
      const link = signalLink(code);
      get("pair-link").value = link;
      get("pair-output-label").textContent = title;
      const qr = get("pair-qr");
      try {
        const matrix = qrcode(0, "L");
        matrix.addData(link);
        matrix.make();
        qr.innerHTML = matrix.createSvgTag({ cellSize: 4, margin: 16, scalable: true });
        qr.setAttribute("role", "img");
        qr.setAttribute("aria-label", title + " QR code");
      } catch {
        qr.textContent = "This link is too long for a QR code. Copy the link instead.";
      }
      output.hidden = false;
    }

    function openPeer(host, players) {
      let started = false;
      peer?.close();
      peer = createPeer(host, {
        async open() {
          if (!host || closed) return;
          await onMatch(peer, 0, players);
          started = transferred = true;
          dialog.close();
        },
        async message(message) {
          if (!started && !host && !closed) {
            await onMatch(peer, 1, message);
            started = transferred = true;
            dialog.close();
          } else if (started) await onMessage(message);
          else throw new Error("Unexpected peer message.");
        },
        closed(reason) {
          if (transferred) onDisconnect(reason);
          else if (!closed) {
            status.textContent = reason;
            create.disabled = submit.disabled = false;
            if (resume) resume.disabled = false;
            hostChoice.hidden = resumeOnly && !saved;
            form.hidden = false;
          }
        },
      });
    }

    async function acceptReply(value) {
      if (acceptingReply || submit.disabled) return;
      acceptingReply = true;
      submit.disabled = true;
      try {
        await peer.accept(value);
        if (!closed) status.textContent = "Reply accepted. Connecting…";
      } catch (error) {
        acceptingReply = false;
        submit.disabled = false;
        report(error);
      }
    }

    function receiveReply(event) {
      if (typeof event.data === "string" && form.dataset.mode === "reply" && peer?.matchesReply(event.data)) void acceptReply(event.data);
    }
    pendingReplies?.addEventListener("message", receiveReply);
    dialog.addEventListener("close", stop);

    async function createInvite(savedMatch = null) {
      const players = [get("host-faction").value, get("guest-faction").value];
      if (!savedMatch && players[0] === players[1]) {
        status.textContent = "Choose two different factions.";
        return;
      }
      create.disabled = submit.disabled = true;
      if (resume) resume.disabled = true;
      status.textContent = "Preparing invite…";
      try {
        openPeer(true, { players, mode: get("match-mode").value, scenario: scenario.value || null, savedMatch });
        const code = await peer.localSignal();
        if (closed) return;
        displayLink(code, "Invite link");
        submit.textContent = "Accept reply";
        form.dataset.mode = "reply";
        get("pair-label").textContent = "Guest’s reply link";
        input.value = "";
        hostChoice.hidden = true;
        status.textContent = "Ask the guest to scan the invite QR or open its link. Then scan their reply QR on this device or paste their reply below.";
      } catch (error) {
        peer?.close();
        create.disabled = false;
        if (resume) resume.disabled = false;
        report(error);
      } finally {
        submit.disabled = false;
      }
    }
    create.addEventListener("click", () => createInvite());
    resume?.addEventListener("click", () => createInvite(saved));

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (form.dataset.mode === "reply") {
        await acceptReply(input.value);
        return;
      }
      if (form.dataset.mode === "handoff") {
        try {
          const code = parseSignalCode(input.value);
          if (!code.startsWith("a1.")) throw new Error("Enter the guest’s reply link.");
          pendingReplies?.postMessage(code);
          status.textContent = "Reply sent to the host tab on this device. Return to that tab to play.";
        } catch (error) {
          report(error);
        }
        return;
      }
      submit.disabled = create.disabled = true;
      if (resume) resume.disabled = true;
      status.textContent = "Preparing reply…";
      try {
        openPeer(false);
        await peer.accept(input.value);
        const code = await peer.localSignal();
        if (closed) return;
        displayLink(code, "Reply link");
        form.hidden = hostChoice.hidden = true;
        status.textContent = "Keep this tab open. Ask the host to scan this reply QR or paste the link in the hosting tab.";
      } catch (error) {
        peer?.close();
        submit.disabled = create.disabled = false;
        if (resume) resume.disabled = false;
        report(error);
      }
    });

    get("copy-pair-link").addEventListener("click", async () => {
      const field = get("pair-link");
      field.select();
      try {
        await navigator.clipboard.writeText(field.value);
        notifyCopy("Link copied. Keep this tab open.");
      } catch {
        notifyCopy("The link is selected. Use your device’s Copy command.");
      }
    });
    function notifyCopy(message) {
      if (!closed) status.textContent = message;
    }

    if (invite) {
      input.value = invite;
      if (invite.startsWith("a1.")) {
        form.dataset.mode = "handoff";
        hostChoice.hidden = true;
        submit.disabled = !pendingReplies;
        submit.textContent = "Send reply to host tab";
        get("pair-label").textContent = "Guest’s reply code";
        status.textContent = pendingReplies ? "Use this on the device that created the invite." : "Copy this code and paste it in the original hosting tab.";
      }
    }
  });
}
