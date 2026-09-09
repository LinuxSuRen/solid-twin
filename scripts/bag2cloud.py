#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
rosbag → PCD/PLY 转换工具（纯 Python，无需安装 ROS）

支持:
  - ROS1 .bag 与 ROS2 bag（目录含 metadata.yaml，或 .db3 文件）
  - sensor_msgs/PointCloud2（sensor_msgs/msg/PointCloud2）
  - livox_ros_driver / livox_ros_driver2 的 CustomMsg（Mid-360 原生消息，
    x/y/z 为 uint32 定点毫米，按 int32 重解释后 / 1000 得到米）

用法示例:
  pip install rosbags numpy
  python scripts/bag2cloud.py dataset.bag                      # 自动挑主题 → out.ply
  python scripts/bag2cloud.py dataset.bag -t /livox/lidar -o map.pcd
  python scripts/bag2cloud.py ros2_bag_dir -t /points --every 5   # 每 5 帧取 1
  python scripts/bag2cloud.py dataset.bag --list               # 列出全部主题
"""
import argparse
import sys
from pathlib import Path

import numpy as np

try:
    from rosbags.typesys import Stores, get_typestore, get_types_from_msg
except ImportError:
    sys.exit('缺少依赖：请先执行  pip install rosbags numpy')

CUSTOM_POINT_DEF_TEMPLATE = '''
uint32 offset_time
uint32 x
uint32 y
uint32 z
uint8 reflectivity
uint8 tag
'''

CUSTOM_MSG_DEF_TEMPLATE = '''
std_msgs/Header header
uint64 timebase
uint32 point_num
uint8 lidar_id
uint8[3] rsvd
{point_type}[] points
'''

PF_DT = {1: 'i1', 2: 'u1', 3: '<i2', 4: '<u2', 5: '<i4', 6: '<u4', 7: '<f4', 8: '<f8'}


def detect_kind(path: Path) -> str:
    if path.is_dir():
        return 'ros2'
    if path.suffix == '.db3':
        return 'ros2'
    if path.suffix == '.bag':
        return 'ros1'
    sys.exit(f'无法识别的输入: {path}（支持 .bag / .db3 / ROS2 bag 目录）')


def build_typestore(kind):
    ts = get_typestore(Stores.ROS2_HUMBLE if kind == 'ros2' else Stores.ROS1_NOETIC)
    # 同时注册 ROS1/ROS2 两个驱动的消息名，兼容各类公开数据集
    for pkg in ('livox_ros_driver', 'livox_ros_driver2'):
        point = f'{pkg}/msg/CustomPoint'
        msg = f'{pkg}/msg/CustomMsg'
        ts.register(get_types_from_msg(CUSTOM_POINT_DEF_TEMPLATE, point))
        ts.register(get_types_from_msg(CUSTOM_MSG_DEF_TEMPLATE.format(point_type=point), msg))
    return ts


def open_reader(path: Path, kind):
    if kind == 'ros1':
        from rosbags.rosbag1 import Reader

        return Reader(path)
    from rosbags.rosbag2 import Reader

    if path.suffix == '.db3':
        path = path.parent
    return Reader(path)


def pick_topic(connections, want):
    types = [(c.topic, c.msgtype) for c in connections]
    if want is None:
        for topic, mtype in types:
            if 'PointCloud2' in mtype or 'CustomMsg' in mtype:
                return topic, mtype
        sys.exit('未自动找到 PointCloud2 / livox CustomMsg 主题，请用 --list 查看后以 -t 指定')
    for topic, mtype in types:
        if topic == want:
            return topic, mtype
    sys.exit(f'主题 {want} 不存在。可用主题：\n  ' + '\n  '.join(f'{t}  [{m}]' for t, m in types))


def pc2_to_arrays(msg):
    """sensor_msgs/PointCloud2 → (xyz Nx3 float64, intensity, rgb)"""
    names = [f.name for f in msg.fields]
    if not all(k in names for k in ('x', 'y', 'z')):
        raise ValueError('PointCloud2 缺少 x/y/z 字段')
    dtype = np.dtype(
        {
            'itemsize': int(msg.point_step),
            'names': names,
            'formats': [PF_DT[int(f.datatype)] for f in msg.fields],
            'offsets': [int(f.offset) for f in msg.fields],
        }
    )
    data = msg.data if isinstance(msg.data, np.ndarray) else np.frombuffer(msg.data, dtype=np.uint8)
    n = int(msg.width) * int(msg.height)
    flat = np.ascontiguousarray(data)[: n * int(msg.point_step)]
    rec = flat.view(dtype=dtype)
    xyz = np.stack(
        [rec['x'].astype(np.float64), rec['y'].astype(np.float64), rec['z'].astype(np.float64)], axis=1
    )
    intensity = rec['intensity'].astype(np.float64) if 'intensity' in names else None
    rgb = None
    if 'rgb' in names and PF_DT[7] in [dtype[f] for f in ['rgb']]:
        packed = rec['rgb'].view(np.uint32) if rec['rgb'].dtype != np.uint32 else rec['rgb']
        rgb = np.stack(
            [(packed >> 16) & 255, (packed >> 8) & 255, packed & 255], axis=1
        ).astype(np.float64) / 255.0
    return xyz, intensity, rgb


def custom_to_arrays(msg):
    """livox CustomMsg → (xyz 米制 Nx3, reflectivity 0..1, None)"""
    pts = msg.points
    if hasattr(pts, 'dtype') and getattr(pts.dtype, 'names', None):
        x = np.asarray(pts['x'], dtype=np.uint32)
        y = np.asarray(pts['y'], dtype=np.uint32)
        z = np.asarray(pts['z'], dtype=np.uint32)
        refl = np.asarray(pts['reflectivity'], dtype=np.uint8)
    else:
        n = len(pts)
        x = np.fromiter((p.x for p in pts), np.uint32, n)
        y = np.fromiter((p.y for p in pts), np.uint32, n)
        z = np.fromiter((p.z for p in pts), np.uint32, n)
        refl = np.fromiter((p.reflectivity for p in pts), np.uint8, n)
    xyz = np.stack(
        [x.astype(np.int32).astype(np.float64), y.astype(np.int32).astype(np.float64), z.astype(np.int32).astype(np.float64)],
        axis=1,
    ) / 1000.0
    return xyz, refl.astype(np.float64) / 255.0, None


def write_pcd(path, xyz, intensity, rgb):
    n = len(xyz)
    fields = ['x', 'y', 'z']
    cols = [np.ascontiguousarray(xyz, dtype='<f4')]
    if intensity is not None:
        fields.append('intensity')
        cols.append(np.ascontiguousarray(intensity, dtype='<f4').reshape(n, 1))
    if rgb is not None:
        fields.append('rgb')
        packed = (
            (np.clip(rgb, 0, 1) * 255).astype(np.uint32)
            @ np.array([65536, 256, 1], dtype=np.uint64)
        ).astype('<u4')
        cols.append(packed.view('<f4').reshape(n, 1))
    body = np.concatenate(cols, axis=1)
    header = (
        '# .PCD v0.7 - Point Cloud Data file format\nVERSION 0.7\nFIELDS '
        + ' '.join(fields)
        + '\n'
        + f'SIZE {" ".join("4" for _ in fields)}\nTYPE {" ".join("F" for _ in fields)}\n'
        + f'COUNT {" ".join("1" for _ in fields)}\nWIDTH {n}\nHEIGHT 1\n'
        + f'VIEWPOINT 0 0 0 1 0 0 0\nPOINTS {n}\nDATA binary\n'
    )
    Path(path).write_bytes(header.encode() + body.tobytes())


def write_ply(path, xyz, intensity, rgb):
    n = len(xyz)
    props = ['property float x', 'property float y', 'property float z']
    cols = [np.ascontiguousarray(xyz, dtype='<f4')]
    if intensity is not None:
        props.append('property float intensity')
        cols.append(np.ascontiguousarray(intensity, dtype='<f4').reshape(n, 1))
    if rgb is not None:
        props += ['property uchar red', 'property uchar green', 'property uchar blue']
        cols.append((np.clip(rgb, 0, 1) * 255).astype(np.uint8).reshape(n, 3))
    body = np.concatenate(cols, axis=1)
    header = (
        f'ply\nformat binary_little_endian 1.0\n'
        f'element vertex {n}\n' + '\n'.join(props) + '\nend_header\n'
    )
    Path(path).write_bytes(header.encode() + body.tobytes())


def main():
    ap = argparse.ArgumentParser(description='rosbag → PCD/PLY（支持 PointCloud2 / livox CustomMsg）')
    ap.add_argument('bag', help='.bag 文件 / .db3 文件 / ROS2 bag 目录')
    ap.add_argument('-t', '--topic', default=None, help='点云主题（默认自动检测）')
    ap.add_argument('-o', '--output', default='out.ply', help='输出文件（.ply 或 .pcd）')
    ap.add_argument('--every', type=int, default=1, help='每 N 帧取 1 帧（控制点数）')
    ap.add_argument('--max-points', type=int, default=0, help='超出后按步长抽稀（0=不限制）')
    ap.add_argument('--list', action='store_true', help='仅列出主题后退出')
    args = ap.parse_args()

    path = Path(args.bag)
    kind = detect_kind(path)
    ts = build_typestore(kind)
    deserialize = ts.deserialize_ros1 if kind == 'ros1' else ts.deserialize_cdr

    with open_reader(path, kind) as reader:
        if args.list:
            for c in reader.connections:
                print(f'{c.topic}  [{c.msgtype}]  ({c.msgcount} msgs)')
            return
        topic, mtype = pick_topic(reader.connections, args.topic)
        is_custom = 'CustomMsg' in mtype
        print(f'读取主题: {topic}  [{mtype}]（{"livox CustomMsg" if is_custom else "PointCloud2"}）')

        xs, ints, rgbs, frames = [], [], [], 0
        seen = 0
        conns = [c for c in reader.connections if c.topic == topic]
        for conn, _t, raw in reader.messages(connections=conns):
            seen += 1
            if (seen - 1) % args.every:
                continue
            msg = deserialize(raw, conn.msgtype)
            if is_custom:
                xyz, intensity, rgb = custom_to_arrays(msg)
            else:
                xyz, intensity, rgb = pc2_to_arrays(msg)
            if not len(xyz):
                continue
            xs.append(xyz)
            if intensity is not None:
                ints.append(intensity)
            if rgb is not None:
                rgbs.append(rgb)
            frames += 1

        if not xs:
            sys.exit('没有读到任何点（检查主题或 --every 参数）')
        xyz = np.concatenate(xs)
        intensity = np.concatenate(ints) if ints else None
        rgb = np.concatenate(rgbs) if rgbs else None

        if args.max_points and len(xyz) > args.max_points:
            stride = int(np.ceil(len(xyz) / args.max_points))
            xyz = xyz[::stride]
            if intensity is not None:
                intensity = intensity[::stride]
            if rgb is not None:
                rgb = rgb[::stride]

        out = Path(args.output)
        (write_pcd if out.suffix == '.pcd' else write_ply)(out, xyz, intensity, rgb)
        print(f'✓ {frames} 帧 / {len(xyz)} 点 → {out}（ROS{1 if kind == "ros1" else 2} bag）')


if __name__ == '__main__':
    main()
