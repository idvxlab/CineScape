import { useState } from "react";
import { useSessionStore } from "@/store/session";
import AlignmentPanel from "@/components/AlignmentPanel";
import ScriptCompare from "@/components/ScriptCompare";
import ShotEditor from "@/components/ShotEditor";

/**
 * Application root — renders the main CineDesign UI.
 *
 * Drives the phase-based workflow using the session store:
 * align ⇄ confirm → generating → candidates ⇄ edit → done.
 * 可在创建会话时上传一张基底图,镜头设计在其上展开
 * (将来生图 API 以它为起点逐镜渲染)。
 */
function App() {
  const {
    sessionId,
    referenceImage,
    currentTurn,
    widgets,
    schemes,
    conflicts,
    loading,
    rendering,
    animating,
    error,
    createSession,
    submitRespond,
    submitConfirm,
    submitSelect,
    submitEdit,
    submitRender,
    submitAnimate,
    goBack,
    canGoBack,
  } = useSessionStore();

  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);

  const header = (subtitle: string) => (
    <div className="app-header">
      {canGoBack() && (
        <button
          className="btn btn-ghost back-btn"
          onClick={() => goBack()}
          disabled={loading || rendering !== null || animating !== null}
          title="返回上一级页面"
        >
          ← 返回上一级
        </button>
      )}
      <h1>CineDesign</h1>
      <p>{subtitle}</p>
      {referenceImage && (
        <img className="reference-thumb" src={referenceImage} alt="参考基底图" />
      )}
    </div>
  );

  const errorBanner = error ? <div className="error-banner">{error}</div> : null;

  // No session yet — show intent input
  if (!sessionId || !currentTurn) {
    return (
      <div>
        {header("可交互的创作意图对齐系统")}
        {errorBanner}
        <div className="card">
          <form
            className="intent-form"
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.target as HTMLFormElement;
              const input = form.elements.namedItem("intent") as HTMLInputElement;
              if (input.value.trim() && imageFile) {
                void createSession(input.value.trim(), imageFile);
              }
            }}
          >
            <h2>上传一张画面,告诉我们你想让观众感受到什么</h2>
            <div className="intent-input-group">
              <input name="intent" placeholder="描述你的创作意图…" />
              <button
                className="btn btn-primary"
                type="submit"
                disabled={loading || !imageFile}
                title={imageFile ? "" : "请先上传参考画面"}
              >
                开始
              </button>
            </div>
            <div className="image-upload">
              <label className="image-upload-label">
                参考画面(必选):我们将为它设计重拍摄方案——画面锚定主体与空间,拍摄风格由你的意图决定
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  disabled={loading}
                  onChange={(e) => {
                    const file = e.target.files?.[0] ?? null;
                    setImageFile(file);
                    setImagePreview(file ? URL.createObjectURL(file) : null);
                  }}
                />
              </label>
              {imagePreview && (
                <div className="image-preview">
                  <img src={imagePreview} alt="预览" />
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => {
                      setImageFile(null);
                      setImagePreview(null);
                    }}
                  >
                    移除
                  </button>
                </div>
              )}
            </div>
          </form>
          {loading && (
            <p className="loading-indicator">
              正在创建会话{imageFile ? "(含画面理解)" : ""}…
            </p>
          )}
        </div>
      </div>
    );
  }

  switch (currentTurn.phase) {
    case "align":
      return (
        <div>
          {header("意图对齐")}
          {errorBanner}
          <div className="card">
            <AlignmentPanel
              widgets={widgets}
              reflection={currentTurn.reflection}
              onSubmit={(responses) => void submitRespond(responses)}
              disabled={loading}
            />
          </div>
          {loading && <p className="loading-indicator">提交中…</p>}
        </div>
      );

    case "confirm":
      return (
        <div>
          {header("确认对齐结果")}
          {errorBanner}
          <div className="card confirm-panel">
            <p className="reflection">{currentTurn.reflection}</p>
            <div className="brief">
              <strong>Brief:</strong> {currentTurn.brief}
            </div>
            <div className="tags">
              {(currentTurn.tags || []).map((t) => (
                <span key={t} className="tag">
                  {t}
                </span>
              ))}
            </div>
            <div className="confirm-actions">
              <button
                className="btn btn-success"
                disabled={loading}
                onClick={() => void submitConfirm(true)}
              >
                确认,开始生成
              </button>
              <button
                className="btn btn-warning"
                disabled={loading}
                onClick={() => {
                  const text = window.prompt("哪里不对?请补充说明:") || undefined;
                  void submitConfirm(false, text);
                }}
              >
                不对,继续澄清
              </button>
            </div>
          </div>
          {loading && <p className="loading-indicator">生成中,请稍候(可能需要 1-2 分钟)…</p>}
        </div>
      );

    case "generating":
      return (
        <div>
          {header("正在生成镜头方案")}
          {errorBanner}
          <div className="card generating-panel">
            <h2>生成中…</h2>
            <ul>
              {currentTurn.progress.map((p, i) => (
                <li key={i}>
                  <span>{p.dir}</span>
                  <span>{p.done ? "✓" : "…"}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      );

    case "candidates":
      return (
        <div>
          {header("选择你偏好的镜头方案")}
          {errorBanner}
          <div className="card candidates-panel">
            <ScriptCompare
              schemes={schemes}
              conflicts={conflicts}
              selectedId={currentTurn.selected_scheme_id}
              renderingId={rendering}
              animatingId={animating}
              onAdopt={(id) => void submitSelect(id, "writeback")}
              onEdit={(id) => void submitSelect(id, "edit")}
              onRender={(id) => void submitRender(id)}
              onAnimate={(id) => void submitAnimate(id)}
              disabled={loading}
            />
          </div>
          {loading && <p className="loading-indicator">处理中…</p>}
          {rendering && (
            <p className="loading-indicator">
              正在以基底图逐镜渲染关键帧(每镜一次图像编辑,约 1-2 分钟)…
            </p>
          )}
          {animating && (
            <p className="loading-indicator">
              正在以关键帧逐镜图生视频(即梦 image2video,约 2-4 分钟)…
            </p>
          )}
        </div>
      );

    case "edit":
      return (
        <div>
          {header("编辑镜头方案")}
          {errorBanner}
          <div className="card edit-panel">
            <ShotEditor
              scheme={currentTurn.scheme}
              conflicts={conflicts}
              onSubmit={(patch, freeText) => void submitEdit(patch, freeText)}
              disabled={loading}
            />
          </div>
          {loading && <p className="loading-indicator">应用编辑并审校中…</p>}
        </div>
      );

    case "done":
      return (
        <div>
          {header("完成")}
          <div className="card done-panel">
            <h2>✓ 方案已采纳</h2>
            {currentTurn.scheme && (
              <>
                <p>
                  <strong>{currentTurn.scheme.strategy}</strong> ·{" "}
                  {currentTurn.scheme.shots.length} 个镜头
                </p>
                <p className="mechanism">{currentTurn.scheme.overall_rationale}</p>
              </>
            )}
            <p>镜头方案已生成并回写方案库(飞轮)。</p>
          </div>
        </div>
      );
  }
}

export default App;
