import { useEffect, useState } from "react";
import { credentialSave, credentialRemove, credentialCheck, credentialConfigure, historyStorage } from "../lib/api";
import { ASPECT_RATIOS, RESOLUTIONS, validateParams } from "../lib/params";
import { DEFAULT_PREFERENCES } from "../lib/workspace";
import type { Preferences, ProviderId, ProviderStatus, CredentialSettings } from "../lib/types";
import Modal from "./Modal";
import { open } from "@tauri-apps/plugin-dialog";

export default function Settings({ prefs, onChange, status, refresh, onClose, onHistory }: {
  prefs: Preferences; onChange: (p: Preferences) => void; status: ProviderStatus | null; refresh: () => Promise<void>; onClose: () => void; onHistory: () => void;
}) {
  const [storage, setStorage] = useState("");
  const [directoryError, setDirectoryError] = useState("");
  const chooseDirectory = async () => {
    try {
      const directory = await open({ directory: true, multiple: false, title: "选择图片默认保存目录", ...(prefs.saveDirectory ? { defaultPath: prefs.saveDirectory } : {}) });
      if (typeof directory === "string") { onChange({ ...prefs, saveDirectory: directory }); setDirectoryError(""); }
    } catch (e) { setDirectoryError("选择目录失败：" + String(e)); }
  };
  useEffect(() => { historyStorage().then(setStorage).catch(e => setStorage(String(e))); }, []);
  const defaultErrors = validateParams(prefs.params, "t2i", prefs.provider);
  if (prefs.compressEnabled && (!Number.isInteger(prefs.maxInputEdge) || prefs.maxInputEdge < 256 || prefs.maxInputEdge > 8192)) defaultErrors.push("默认长边上限须为 256–8192 之间的整数");
  return <Modal title="设置" onClose={onClose}>
    <div className="settings-content">
      <section><h3>外观</h3><label>主题<select value={prefs.theme} onChange={e => onChange({ ...prefs, theme: e.target.value as Preferences["theme"] })}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label></section>
      <section><h3>API Key</h3>
        {(["openrouter", "bfl"] as const).map(p => <KeySettingsCard key={p} provider={p} status={status} refresh={refresh} />)}
      </section>
      <section><h3>新建方案的默认值</h3>
        <div className="field-grid">
          <label>默认提供商<select value={prefs.provider} onChange={e => onChange({ ...prefs, provider: e.target.value as ProviderId })}><option value="openrouter">OpenRouter</option><option value="bfl">BFL 直连</option></select></label>
          <label>分辨率<select value={prefs.params.resolution} onChange={e => onChange({ ...prefs, params: { ...prefs.params, resolution: e.target.value } })}>{RESOLUTIONS.map(r => <option key={r.value}>{r.value}</option>)}</select></label>
          <label>宽高比<select value={prefs.params.aspectRatio} onChange={e => onChange({ ...prefs, params: { ...prefs.params, aspectRatio: e.target.value } })}>{ASPECT_RATIOS.map(a => <option key={a}>{a}</option>)}</select></label>
          <label>内容安全<select value={prefs.params.safetyTolerance ?? ""} onChange={e => onChange({ ...prefs, params: { ...prefs.params, safetyTolerance: e.target.value === "" ? null : Number(e.target.value) } })}><option value="">提供商默认</option>{[0, 1, 2, 3, 4, 5, 6].map(n => <option key={n}>{n}</option>)}</select></label>
        </div>
        <label className="check"><input type="checkbox" checked={prefs.params.grounding ?? true} onChange={e => onChange({ ...prefs, params: { ...prefs.params, grounding: e.target.checked } })} />BFL 默认联网参考</label>
        <label className="check"><input type="checkbox" checked={prefs.compressEnabled} onChange={e => onChange({ ...prefs, compressEnabled: e.target.checked })} />默认等比缩小参考图</label>
        <label>默认长边上限（px）<input type="number" min={256} max={8192} value={prefs.maxInputEdge} onChange={e => onChange({ ...prefs, maxInputEdge: Number(e.target.value) })} /></label>
        {defaultErrors.map(e => <p className="error-text" key={e}>{e}</p>)}
        <button onClick={() => onChange({ ...DEFAULT_PREFERENCES, params: { ...DEFAULT_PREFERENCES.params } })}>重置偏好</button>
      </section>
      <section><h3>图片默认保存位置</h3><p className="storage-path">{prefs.saveDirectory || "未指定"}</p><div className="row"><button onClick={() => void chooseDirectory()}>选择文件夹</button><button disabled={!prefs.saveDirectory} onClick={() => onChange({ ...prefs, saveDirectory: "" })}>使用系统默认</button></div>{directoryError && <p className="error-text" role="alert">{directoryError}</p>}</section>
      <section><h3>本地历史存储</h3><p className="storage-path">{storage}</p><button onClick={onHistory}>管理历史记录</button></section>
    </div>
  </Modal>;
}

function KeySettingsCard({ provider, status, refresh }: { provider: ProviderId; status: ProviderStatus | null; refresh: () => Promise<void> }) {
  const defaultName = provider === "bfl" ? "BFL_API_KEY" : "OPENROUTER_API_KEY";
  const active: CredentialSettings = status?.settings?.[provider] ?? { source: status?.sources?.[provider] === "system" ? "manual" : "environment", envName: defaultName };
  const [selection, setSelection] = useState<CredentialSettings>(active);
  const [key, setKey] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setSelection({ source: active.source, envName: active.envName }); }, [active.source, active.envName]);
  const changed = selection.source !== active.source || selection.envName.trim() !== active.envName;
  const validName = !!selection.envName.trim() && !/[=\0\r\n]/.test(selection.envName);
  const configured = !!status?.[provider];
  const stored = status?.storedKeys?.[provider] ?? status?.sources?.[provider] === "system";
  const run = async (action: "apply" | "save" | "remove" | "check") => {
    setBusy(true); setMessage("");
    try {
      const config = { ...selection, envName: selection.envName.trim() || defaultName };
      if (action === "save") {
        await credentialSave(provider, key); setKey("");
        await credentialConfigure(provider, { ...config, source: "manual" });
        setMessage("手动密钥已保存并启用，尚未验证连接");
      }
      if (action === "apply") { await credentialConfigure(provider, config); setMessage("已应用密钥来源，尚未验证连接"); }
      if (action === "remove") { await credentialRemove(provider); setMessage("手动密钥已移除，请重新填写或切换来源"); }
      if (action === "check") setMessage(await credentialCheck(provider));
      await refresh();
    } catch (e) { setMessage(String(e)); }
    finally { setBusy(false); }
  };
  return <div className="key-settings">
    <div className="section-heading"><strong>{provider === "bfl" ? "BFL 直连" : "OpenRouter"}</strong><span className="muted">{configured ? "已配置" : "未配置"}</span></div>
    <label>密钥来源<select disabled={busy || !status} value={selection.source} onChange={e => { setSelection(s => ({ ...s, source: e.target.value as CredentialSettings["source"] })); setMessage(""); }}><option value="environment">环境变量</option><option value="manual">手动填写</option></select></label>
    {selection.source === "environment" ? <>
      <label>环境变量名称<input disabled={busy} autoComplete="off" spellCheck={false} value={selection.envName} placeholder={defaultName} onChange={e => { setSelection(s => ({ ...s, envName: e.target.value })); setMessage(""); }} /></label>
      <p className="help">读取此名称的用户级环境变量，未找到时读取进程环境变量。</p>
      {!validName && <p className="error-text">请输入有效的环境变量名称，不含等号或换行。</p>}
    </> : <>
      <label>输入或替换密钥<input disabled={busy} type="password" autoComplete="off" spellCheck={false} value={key} placeholder={stored ? "已有手动密钥，填写以替换" : "保存后清空输入框"} onChange={e => setKey(e.target.value)} /></label>
      <p className="help">密钥保存在系统凭据存储，不写入草稿或历史。</p>
    </>}
    {changed && <p className="help">来源设置尚未应用，生成仍使用原设置。</p>}
    <div className="row">
      <button disabled={busy || !status || !changed || (selection.source === "environment" && !validName)} onClick={() => void run("apply")}>应用来源</button>
      {selection.source === "manual" && <><button disabled={busy || !key.trim()} onClick={() => void run("save")}>保存并使用密钥</button><button disabled={busy || !stored} onClick={() => void run("remove")}>移除手动密钥</button></>}
      <button disabled={busy || !configured || changed} onClick={() => void run("check")}>检查连接</button>
    </div>
    {message && <p className="help" role="status">{message}</p>}
  </div>;
}
