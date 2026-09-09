#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
构造合成 ROS1 .bag 测试包（无需 ROS 环境与真实雷达）：
  /livox/lidar   livox_ros_driver/CustomMsg  （Mid-360 原生消息，500 点 × 2 帧）
  /points        sensor_msgs/PointCloud2     （300 点 × 2 帧）
坐标值确定性生成，用于 scripts/test_loaders.mjs 的往返校验。

  pip install rosbags numpy
  python scripts/make_test_bag.py            # → test_data/synthetic.bag
"""
import sys
from pathlib import Path

import numpy as np

try:
    from rosbags.rosbag1 import Writer
    from rosbags.typesys import Stores, get_typestore, get_types_from_msg
except ImportError:
    sys.exit('缺少依赖：请先执行  pip install rosbags numpy')

CUSTOM_POINT_DEF = '''
uint32 offset_time
uint32 x
uint32 y
uint32 z
uint8 reflectivity
uint8 tag
'''
CUSTOM_MSG_DEF = '''
std_msgs/Header header
uint64 timebase
uint32 point_num
uint8 lidar_id
uint8[3] rsvd
livox_ros_driver/msg/CustomPoint[] points
'''


def main():
    ts = get_typestore(Stores.ROS1_NOETIC)
    ts.register(get_types_from_msg(CUSTOM_POINT_DEF, 'livox_ros_driver/msg/CustomPoint'))
    ts.register(get_types_from_msg(CUSTOM_MSG_DEF, 'livox_ros_driver/msg/CustomMsg'))

    Header = ts.types['std_msgs/msg/Header']
    Time = ts.types['builtin_interfaces/msg/Time']
    PointField = ts.types['sensor_msgs/msg/PointField']
    PointCloud2 = ts.types['sensor_msgs/msg/PointCloud2']
    CustomMsg = ts.types['livox_ros_driver/msg/CustomMsg']
    CustomPoint = ts.types['livox_ros_driver/msg/CustomPoint']

    out_dir = Path(__file__).parent.parent / 'test_data'
    out_dir.mkdir(exist_ok=True)
    out = out_dir / 'synthetic.bag'
    out.unlink(missing_ok=True)

    # livox CustomMsg：500 点，uint32 毫米定点
    n_lidar = 500
    points = []
    for j in range(n_lidar):
        points.append(
            CustomPoint(
                offset_time=j * 1000,
                x=np.uint32((j % 50) * 10),
                y=np.uint32(1200),
                z=np.uint32((j // 50) * 5),
                reflectivity=np.uint8(j % 256),
                tag=np.uint8(0),
            )
        )

    # PointCloud2：300 点 float32
    n_pc = 300
    arr = np.zeros(n_pc, dtype=np.dtype([('x', '<f4'), ('y', '<f4'), ('z', '<f4'), ('intensity', '<f4')]))
    arr['x'] = [(j % 30) * 0.1 for j in range(n_pc)]
    arr['y'] = [(j // 30) * 0.1 for j in range(n_pc)]
    arr['z'] = [1.5] * n_pc
    arr['intensity'] = [(j % 256) / 255.0 for j in range(n_pc)]
    step = 16
    pf = [
        PointField(name='x', offset=0, datatype=np.uint8(7), count=np.uint32(1)),
        PointField(name='y', offset=4, datatype=np.uint8(7), count=np.uint32(1)),
        PointField(name='z', offset=8, datatype=np.uint8(7), count=np.uint32(1)),
        PointField(name='intensity', offset=12, datatype=np.uint8(7), count=np.uint32(1)),
    ]

    with Writer(out) as w:
        conn_lidar = w.add_connection('/livox/lidar', 'livox_ros_driver/msg/CustomMsg', typestore=ts)
        conn_pc = w.add_connection('/points', 'sensor_msgs/msg/PointCloud2', typestore=ts)

        for frame in range(2):
            t0 = 1_700_000_000_000_000_000 + frame * 100_000_000
            hdr = Header(seq=frame, stamp=Time(sec=int(t0 // 1_000_000_000), nanosec=int(t0 % 1_000_000_000)), frame_id='livox_frame')
            cmsg = CustomMsg(
                header=hdr,
                timebase=np.uint64(t0),
                point_num=np.uint32(n_lidar),
                lidar_id=np.uint8(0),
                rsvd=np.zeros(3, dtype=np.uint8),
                points=points,
            )
            w.write(conn_lidar, t0, ts.serialize_ros1(cmsg, 'livox_ros_driver/msg/CustomMsg'))

            pc2 = PointCloud2(
                header=hdr,
                height=np.uint32(1),
                width=np.uint32(n_pc),
                fields=pf,
                is_bigendian=np.uint8(0),
                point_step=np.uint32(step),
                row_step=np.uint32(step * n_pc),
                data=np.frombuffer(arr.tobytes(), dtype=np.uint8),
                is_dense=np.uint8(1),
            )
            w.write(conn_pc, t0, ts.serialize_ros1(pc2, 'sensor_msgs/msg/PointCloud2'))

    print(f'✓ 合成 bag 已生成: {out}（livox CustomMsg 500×2, PointCloud2 300×2）')


if __name__ == '__main__':
    main()
