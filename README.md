# solid-twin

基于 **Livox Mid-360** 的 3D 数字孪生查看器 **原型**。无需任何雷达设备即可完整体验：
内置 Mid-360 非重复扫描仿真器，并可直接载入公开数据集（bag 转换后的 PCD/PLY）离线测试。

![tech](https://img.shields.io/badge/simulation-Mid--360%20rosette%20scan-4ea1ff) ![formats](https://img.shields.io/badge/formats-PLY%20%7C%20PCD%20%7C%20LAS%20%7C%20KITTI%20bin%20%7C%20XYZ-35c3c8)

## 快速开始

```bash
pnpm install
pnpm dev          # → http://127.0.0.1:5180
```

打开页面后会自动生成约 60 万点的模拟扫描（3 个测站拼接的仓库场景），并按扫描时间顺序回放，
直观展示 Mid-360 玫瑰形非重复扫描的累积覆盖效果。

### 界面功能

| 分区 | 功能 |
| :-- | :-- |
| 数据 | 打开 / 拖放点云文件；重新生成模拟扫描；多图层管理与显隐 |
| 显示 | 着色模式（高程 Turbo / 强度 Viridis / 原始 RGB / 测站）、**坐标朝向（PCA 自动 / X / Y / Z 手动）**、点大小、点数比例抽稀、网格 / 坐标轴 / 亮色背景 |
| 扫描回放 | 按扫描时间顺序逐点回放（×0.5 ~ ×20），演示非重复扫描模式 |
| 视图与导出 | 适配视野 / 俯视 / 等轴测；截图 PNG；导出当前可见点云为 binary PCD（恢复原始坐标与朝向） |

**坐标朝向自动检测**：载入外部文件时对点云做 PCA，把地面法向（最小特征向量）旋转到
Y-up——顺带校正 SLAM 漂移导致的倾斜（如实测数据常见的几度量级倾角）。外部文件载入后
默认俯视图（平面图视角）；检测不可靠时（立面 / 隧道等非地面主导场景）可用「坐标朝向」
下拉手动覆盖。导出 PCD 时自动逆转旋转、恢复文件原始坐标。

### 设备与告警（数字孪生锚点）

```
标记设备 → 点击点云吸附质心 → 填 ID/类型（可阵列复制成排设备）
        → devices.json（原始坐标持久化，可导入导出）
告警源  → 模拟按钮 / WebSocket({type:'alarm',id,level,message})
        → 标记变色脉冲 + 标签牌 + 信息流 + 提示音 + 点击定位
```

- **ID 是唯一关联键**：与台账系统、MQTT/OPC UA tag、未来 glTF 节点名共用同一套编码
- 锚点存**原始文件坐标**，重定向/重导入后自动贴合（经图层变换双向换算）
- 标记模式下点击自动做 **0.6m 邻域质心吸附**，抗单点噪声
- 同类设备支持**阵列复制**（方向 × 间距 × 数量，ID 自动编号 `BAT-A1…An`）
- WebSocket 协议：`{"type":"alarm","id":"BAT-A1","level":"warn","message":"…"}` /
  `{"type":"clear","id":"BAT-A1"}`，断线自动重连

## 支持的数据格式

| 格式 | 说明 | 限制 |
| :-- | :-- | :-- |
| **PCD** (PCL) | ascii / binary；FAST-LIO2、Point-LIO 输出的 `x y z intensity` 布局 | `binary_compressed` (LZF) 需先转存 |
| **PLY** | ascii / binary (LE+BE)；读取 x y z + RGB + intensity | vertex 前的 list 属性元素不支持 |
| **LAS** 1.0–1.4 | 点格式 0,1,2,3,6,7,8,10（含 RGB / 强度）；大坐标自动重居中防 float32 精度损失 | **LAZ 压缩**需先解压（CloudCompare / las2las） |
| **KITTI .bin** | 每点 4×float32 (x,y,z,intensity) | — |
| **XYZ / TXT / CSV** | 自动识别 3/4/6/7 列布局，RGB 量程自动判断 | — |

超大文件（>800 万点）自动按步长抽稀保证流畅。

## 用公开数据包离线测试（无需设备）

公开的 Mid-360 / SLAM 数据集几乎都以 **rosbag**（ROS1 `.bag` 或 ROS2 `.db3`）发布。本仓库提供
纯 Python 转换脚本（基于 [`rosbags`](https://pypi.org/project/rosbags/) 库，**无需安装 ROS**），
同时支持 `sensor_msgs/PointCloud2` 和 Mid-360 原生的 `livox_ros_driver2/CustomMsg`：

```bash
python3 -m venv .venv && .venv/bin/pip install rosbags numpy

# 1) 列出 bag 中的主题
python scripts/bag2cloud.py 数据集.bag --list

# 2) 转换为 PLY / PCD（--every 5 = 每 5 帧取 1 帧控制点数）
python scripts/bag2cloud.py 数据集.bag -t /livox/lidar -o map.ply --every 5

# 3) 把 map.ply 拖进浏览器即可
```

推荐的数据集来源（入口稳定，具体下载链接见各仓库 README）：

- [hku-mars/FAST_LIO](https://github.com/hku-mars/FAST_LIO) — LiDAR-惯性里程计，README 附 Livox 系列数据集
- [hku-mars/Point-LIO](https://github.com/hku-mars/Point-LIO) — 含 Mid-360 数据包
- [hku-mars/FAST_LIVO2](https://github.com/hku-mars/FAST_LIVO2) — Mid-360 彩色重建数据
- [KITTI Odometry](http://www.cvlibs.net/datasets/kitti/eval_odometry.php) — velodyne `.bin` 可直读（无需转换）
- Livox 官方驱动与文档：[Livox-SDK/livox_ros_driver2](https://github.com/Livox-SDK/livox_ros_driver2)

## 回归测试

全链路「合成 bag → bag2cloud → PCD/PLY → 浏览器解析器」已用确定性数据验证：

```bash
.venv/bin/python scripts/make_test_bag.py                      # 构造合成 ROS1 bag（CustomMsg + PointCloud2）
.venv/bin/python scripts/bag2cloud.py test_data/synthetic.bag -t /livox/lidar -o test_data/custom_msg.ply
.venv/bin/python scripts/bag2cloud.py test_data/synthetic.bag -t /points -o test_data/pc2.pcd
node scripts/gen_sample.mjs                                    # 生成 data/mid360_room_sample.pcd（约 20 万点）
node scripts/test_loaders.mjs                                  # 断言坐标 / 强度 / 点数往返一致
```

## 项目结构

```
solid-twin/
├── index.html               # 页面骨架（面板 / HUD / 拖放层）
├── src/
│   ├── main.js              # 入口：UI 交互、模拟扫描、文件载入、PCD 导出
│   ├── viewer.js            # TwinViewer：Three.js 场景、着色、抽稀、回放、视图
│   ├── colormaps.js         # Jet / Viridis / 测站调色板
│   ├── ui.css
│   ├── sim/mid360.js        # Mid-360 玫瑰形非重复扫描仿真（纯数学，浏览器/Node 通用）
│   └── loaders/             # pcd / ply / las / kitti / xyz 解析 + 格式嗅探与后处理
├── scripts/
│   ├── bag2cloud.py         # rosbag → PCD/PLY（ROS1/ROS2，CustomMsg + PointCloud2）
│   ├── make_test_bag.py     # 构造合成测试 bag
│   ├── gen_sample.mjs       # 导出仿真样本 PCD
│   └── test_loaders.mjs     # Node 端解析器回归测试
├── data/mid360_room_sample.pcd   # 仿真样本（3 测站 × 约 6.7 万点）
└── test_data/               # 合成 bag 与转换产物
```

## 已知限制（原型阶段）

- 多文件各图层独立重居中，**不做跨文件配准对齐**（单地图内多站数据请先用 SLAM 输出合并地图）
- LAZ / PCD-LZF 压缩格式、点云 LOD（Potree 八叉树）暂未支持
- 数千万点级别建议用 `--every` / `--max-points` 预先降采样

## 后续路线（接入实机 Mid-360）

1. **采集**：Mid-360 + 边缘计算单元（Jetson / RK3588），`livox_ros_driver2` 录制 `CustomMsg`
2. **建图**：FAST-LIO2（几何）或 FAST-LIVO2（带颜色）实时里程计与建图，输出合并 PCD
3. **查看**：产出的 PCD 直接拖入本查看器（链路已由回归测试覆盖）
4. **演进**：八叉树 LOD 大场景、Poisson 网格重建、语义标注、BIM 模型对齐、真·数字孪生实时流
