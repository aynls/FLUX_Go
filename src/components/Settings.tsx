import { useEffect, useState } from "react";
import {
  credentialSave,
  credentialRemove,
  credentialCheck,
  credentialConfigure,
  historyStorage,
} from "../lib/api";
import { DEFAULT_PREFERENCES, newDraft } from "../lib/workspace";
import type {
  Draft,
  FamilyId,
  Preferences,
  ProviderId,
  ProviderStatus,
  CredentialSettings,
} from "../lib/types";
import Modal from "./Modal";
import { open } from "@tauri-apps/plugin-dialog";
import {
  providers,
  families,
  catalog,
  modelById,
  fieldsFor,
  changeRoute,
  validateFields,
} from "../models/catalog";
import { ParameterFields, QwenSizeFields } from "../workspaces/shared/Controls";

export default function Settings({
  prefs,
  onChange,
  status,
  refresh,
  onClose,
  onHistory,
  initialProvider,
}: {
  prefs: Preferences;
  onChange: (p: Preferences) => void;
  status: ProviderStatus | null;
  refresh: () => Promise<void>;
  onClose: () => void;
  onHistory: () => void;
  initialProvider?: ProviderId;
}) {
  const [page, setPage] = useState("connection");
  const [provider, setProvider] = useState<ProviderId>(
    initialProvider ?? prefs.provider,
  );
  const [family, setFamily] = useState<FamilyId>(prefs.defaultFamily ?? "flux");
  const [storage, setStorage] = useState("");
  const [directoryError, setDirectoryError] = useState("");
  useEffect(() => {
    historyStorage()
      .then(setStorage)
      .catch((e) => setStorage(String(e)));
  }, []);
  const defaults = newDraft(prefs, family),
    fields = fieldsFor(defaults);
  const updateDefaults = (d: Draft) =>
    onChange({
      ...prefs,
      familyDefaults: {
        ...prefs.familyDefaults,
        [family]: {
          modelId: d.modelId,
          provider: d.provider,
          params: d.params,
        },
      },
    });
  const chooseDirectory = async () => {
    try {
      const directory = await open({
        directory: true,
        multiple: false,
        title: "选择图片默认保存目录",
        ...(prefs.saveDirectory ? { defaultPath: prefs.saveDirectory } : {}),
      });
      if (typeof directory === "string") {
        onChange({ ...prefs, saveDirectory: directory });
        setDirectoryError("");
      }
    } catch (e) {
      setDirectoryError("选择目录失败：" + String(e));
    }
  };
  return (
    <Modal title="偏好设置" onClose={onClose} large>
      <div className="settings-content">
        <nav className="settings-navigation" aria-label="设置分类">
          {[
            ["connection", "API 连接"],
            ["defaults", "新建默认值"],
            ["appearance", "外观"],
            ["storage", "存储"],
          ].map(([id, label]) => (
            <button
              key={id}
              aria-current={page === id ? "page" : undefined}
              className={page === id ? "active" : ""}
              onClick={() => setPage(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="settings-panel">
          {page === "connection" && (
            <section>
              <h3>API 连接</h3>
              <div className="provider-selector">
                {providers.map((p) => (
                  <button
                    key={p.id}
                    className={provider === p.id ? "active" : ""}
                    aria-pressed={provider === p.id}
                    onClick={() => setProvider(p.id)}
                  >
                    <span>{p.label}</span>
                    <span className="muted">
                      {status?.[p.id] ? "已配置" : "未配置"}
                    </span>
                  </button>
                ))}
              </div>
              <KeySettingsCard
                key={provider}
                provider={provider}
                status={status}
                refresh={refresh}
              />
            </section>
          )}
          {page === "defaults" && (
            <>
              <section>
                <h3>新建方案的默认值</h3>
                <p className="muted">用于下次新建，当前方案保持原设置。</p>
                <label>
                  启动时的模型家族
                  <select
                    value={prefs.defaultFamily ?? "flux"}
                    onChange={(e) =>
                      onChange({
                        ...prefs,
                        defaultFamily: e.target.value as FamilyId,
                      })
                    }
                  >
                    {families.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="segmented">
                  {families.map((f) => (
                    <button
                      key={f.id}
                      aria-pressed={family === f.id}
                      onClick={() => setFamily(f.id)}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
                <label>
                  默认模型
                  <select
                    value={defaults.modelId}
                    onChange={(e) => {
                      const model = modelById(e.target.value)!;
                      updateDefaults(
                        changeRoute(
                          defaults,
                          model.routes[defaults.provider]
                            ? defaults.provider
                            : (Object.keys(model.routes)[0] as ProviderId),
                          model.id,
                        ),
                      );
                    }}
                  >
                    {catalog.models
                      .filter((m) => m.family === family)
                      .map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  默认提供商
                  <select
                    value={defaults.provider}
                    onChange={(e) =>
                      updateDefaults(
                        changeRoute(defaults, e.target.value as ProviderId),
                      )
                    }
                  >
                    {providers
                      .filter((p) => modelById(defaults.modelId)?.routes[p.id])
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                  </select>
                </label>
                {family === "qwen" && (
                  <QwenSizeFields draft={defaults} onChange={updateDefaults} />
                )}
                <ParameterFields
                  draft={defaults}
                  onChange={updateDefaults}
                  keys={Object.keys(fields).filter(
                    (k) =>
                      family !== "qwen" ||
                      ![
                        "resolution",
                        "aspectRatio",
                        "width",
                        "height",
                        "count",
                      ].includes(k),
                  )}
                />
                {validateFields(defaults).map((e) => (
                  <p key={e} className="error-text" role="alert">
                    {e}
                  </p>
                ))}
                <button
                  onClick={() =>
                    updateDefaults({
                      ...defaults,
                      params: newDraft(
                        { ...DEFAULT_PREFERENCES, provider: defaults.provider },
                        family,
                      ).params,
                    })
                  }
                >
                  重置此家族默认值
                </button>
              </section>
              <section>
                <h3>参考图处理</h3>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={prefs.compressEnabled}
                    onChange={(e) =>
                      onChange({ ...prefs, compressEnabled: e.target.checked })
                    }
                  />
                  默认等比缩小参考图
                </label>
                <label>
                  默认长边上限（px）
                  <input
                    type="number"
                    min={256}
                    max={8192}
                    disabled={!prefs.compressEnabled}
                    value={prefs.maxInputEdge}
                    onChange={(e) =>
                      onChange({
                        ...prefs,
                        maxInputEdge: Number(e.target.value),
                      })
                    }
                  />
                </label>
                {prefs.compressEnabled &&
                  (!Number.isInteger(prefs.maxInputEdge) ||
                    prefs.maxInputEdge < 256 ||
                    prefs.maxInputEdge > 8192) && (
                    <p className="error-text">长边上限须为 256–8192px</p>
                  )}
              </section>
            </>
          )}
          {page === "appearance" && (
            <section>
              <h3>外观</h3>
              <label>
                主题
                <select
                  value={prefs.theme}
                  onChange={(e) =>
                    onChange({
                      ...prefs,
                      theme: e.target.value as Preferences["theme"],
                    })
                  }
                >
                  <option value="system">跟随系统</option>
                  <option value="light">浅色</option>
                  <option value="dark">深色</option>
                </select>
              </label>
              <span className="muted">即时生效</span>
            </section>
          )}
          {page === "storage" && (
            <>
              <section>
                <h3>图片默认保存位置</h3>
                <p className="storage-path">
                  {prefs.saveDirectory || "系统默认"}
                </p>
                <div className="row">
                  <button onClick={() => void chooseDirectory()}>
                    选择文件夹
                  </button>
                  <button
                    disabled={!prefs.saveDirectory}
                    onClick={() => onChange({ ...prefs, saveDirectory: "" })}
                  >
                    使用系统默认
                  </button>
                </div>
                {directoryError && (
                  <p className="error-text" role="alert">
                    {directoryError}
                  </p>
                )}
              </section>
              <section>
                <h3>本地历史</h3>
                <p className="storage-path">{storage}</p>
                <button onClick={onHistory}>管理历史记录</button>
              </section>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
function KeySettingsCard({
  provider,
  status,
  refresh,
}: {
  provider: ProviderId;
  status: ProviderStatus | null;
  refresh: () => Promise<void>;
}) {
  const definition = providers.find((p) => p.id === provider)!;
  const defaultName = definition.envName;
  const active: CredentialSettings = status?.settings?.[provider] ?? {
    source: status?.sources?.[provider] === "system" ? "manual" : "environment",
    envName: defaultName,
  };
  const [selection, setSelection] = useState<CredentialSettings>(active);
  const [key, setKey] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setSelection({ source: active.source, envName: active.envName });
  }, [active.source, active.envName]);
  const changed =
    selection.source !== active.source ||
    selection.envName.trim() !== active.envName;
  const validName =
    !!selection.envName.trim() && !/[=\0\r\n]/.test(selection.envName);
  const configured = !!status?.[provider];
  const stored =
    status?.storedKeys?.[provider] ?? status?.sources?.[provider] === "system";
  const run = async (action: "apply" | "save" | "remove" | "check") => {
    setBusy(true);
    setMessage("");
    try {
      const config = {
        ...selection,
        envName: selection.envName.trim() || defaultName,
      };
      if (action === "save") {
        await credentialSave(provider, key);
        setKey("");
        await credentialConfigure(provider, { ...config, source: "manual" });
        setMessage("手动密钥已保存并启用，尚未验证连接");
      }
      if (action === "apply") {
        await credentialConfigure(provider, config);
        setMessage("已应用密钥来源，尚未验证连接");
      }
      if (action === "remove") {
        await credentialRemove(provider);
        setMessage("手动密钥已移除，请重新填写或切换来源");
      }
      if (action === "check") setMessage(await credentialCheck(provider));
      await refresh();
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="key-settings">
      <div className="section-heading">
        <strong>{definition.label}</strong>
        <span className="muted">{configured ? "已配置" : "未配置"}</span>
      </div>
      <label>
        密钥来源
        <select
          disabled={busy || !status}
          value={selection.source}
          onChange={(e) => {
            setSelection((s) => ({
              ...s,
              source: e.target.value as CredentialSettings["source"],
            }));
            setMessage("");
          }}
        >
          <option value="environment">环境变量</option>
          <option value="manual">手动填写</option>
        </select>
      </label>
      {selection.source === "environment" ? (
        <>
          <label>
            环境变量名称
            <input
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              value={selection.envName}
              placeholder={defaultName}
              onChange={(e) => {
                setSelection((s) => ({ ...s, envName: e.target.value }));
                setMessage("");
              }}
            />
          </label>
          {!validName && (
            <p className="error-text">
              请输入有效的环境变量名称，不含等号或换行。
            </p>
          )}
        </>
      ) : (
        <>
          <label>
            输入或替换密钥
            <input
              disabled={busy}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              placeholder={
                stored ? "已有手动密钥，填写以替换" : "保存后清空输入框"
              }
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
          <span className="muted">保存到系统凭据存储</span>
        </>
      )}
      {changed && <p className="help">来源设置尚未应用，生成仍使用原设置。</p>}
      <div className="row">
        <button
          disabled={
            busy ||
            !status ||
            !changed ||
            (selection.source === "environment" && !validName)
          }
          onClick={() => void run("apply")}
        >
          应用来源
        </button>
        {selection.source === "manual" && (
          <>
            <button
              disabled={busy || !key.trim()}
              onClick={() => void run("save")}
            >
              保存并使用密钥
            </button>
            <button
              disabled={busy || !stored}
              onClick={() => void run("remove")}
            >
              移除手动密钥
            </button>
          </>
        )}
        <button
          disabled={
            busy ||
            !configured ||
            changed ||
            provider === "ark" ||
            provider === "byteplus"
          }
          title={
            provider === "ark" || provider === "byteplus"
              ? "请通过实际生成确认密钥和模型权限"
              : undefined
          }
          onClick={() => void run("check")}
        >
          检查连接
        </button>
      </div>
      {message && (
        <p className="help" role="status">
          {message}
        </p>
      )}
    </div>
  );
}
