# 接进 DaVinci Resolve / After Effects

---

## DaVinci Resolve

Resolve 对 ProRes 4444 的 Alpha 支持非常好，所以**最推荐先转 ProRes**。

### 步骤

1. 工作室 `导出…` → **PNG 序列（ZIP，含透明）**，解压到比如 `D:\ev_overlay\`
2. 转成 ProRes 4444：

```bash
python tools/encode.py --in "D:\ev_overlay" --out "D:\ev_overlay.mov" --codec prores4444 --fps 24
```

3. Resolve 里：`文件 → 导入 → 媒体`，把 mov 拖进媒体池
4. 拖到时间轴的 **V2** 轨道，V1 放实拍
5. 选中 V2 的片段，检查 `检查器 → 合成`：混合模式"常规"，Alpha 模式"直接"

### 直接导 PNG 序列也行

媒体池右键 → `导入媒体` → 选中第一帧 → 在弹窗里勾 **"自动识别图像序列"**。

### 卡点

1. `导出… → 卡点标记` 得到 txt（`时:分:秒:帧` 格式）
2. Resolve 里时间线右键 → `添加标记`，把时间码对着填
3. 更快的办法：先把标记时间抄成一张表，切镜头时照着对齐

---

## After Effects

### 用法一：PNG 序列当素材（推荐）

1. `导出… → PNG 序列（ZIP，含透明）`，解压
2. AE：`文件 → 导入 → 文件…`，选中第一张 PNG，勾上 **PNG Sequence**，帧率填与导出一致
3. 拖进合成，放在实拍图层上方
4. AE 自动识别 Alpha，不用额外设置

> **帧率提醒**：`解释素材 → 主要 → 帧速率` 一定要和导出时一致，否则整段速度不对。

### 用法二：ProRes 4444

```bash
python tools/encode.py --in 解压目录 --out ESCAPE.mov --codec prores4444 --fps 24
```

拖进 AE 即用，带 Alpha。

### 用法三：在 AE 里做二次加工

MotionKit 的每个模板都是可读的 JS，参数名和最终画面一一对应。常见做法：

1. 在工作室里把参数调到满意
2. 导出 PNG 序列 / ProRes 4444
3. AE 里加发光（Glow）、方向模糊、调色，做成你自己的风格

---

## 通用提醒

- **帧率**：导出和剪辑工程必须一致，否则卡点会整体漂移
- **分辨率**：叠加层分辨率不要低于时间线。要放大就导出 4K，别拿小图放大
- **色彩空间**：PNG / ProRes 都是 sRGB。Resolve 里若是 DaVinci Wide Gamut 工程，
  给叠加层套一个 `色彩空间转换`（sRGB → 工程空间），否则颜色会发灰
- **黑底问题**：叠上去是黑底而不是透明，说明 Alpha 没读到。
  先确认 PNG 本身带透明（看图软件里应是棋盘格背景），再换 ProRes 4444 试
