import socket
import struct
import threading
import time
import math
from dataclasses import dataclass
from typing import List, Tuple

MAGIC = 0xA55A

MSG_TYPE_COMMAND = 0x01
MSG_TYPE_STATUS = 0x02
MSG_TYPE_ACK = 0x03

FLIGHT_MODE_HOVER = 0x00
FLIGHT_MODE_WAYPOINT = 0x01
FLIGHT_MODE_RETURN = 0x02

DRONE_COUNT = 20
STATUS_INTERVAL = 0.2

MSG_TYPE_SET_RATE = 0x04


@dataclass
class Waypoint:
    lat: float
    lng: float
    alt: float


@dataclass
class DroneState:
    id: int
    lat: float
    lng: float
    alt: float
    battery: int
    roll: float
    pitch: float
    yaw: float
    status: int
    target_waypoints: List[Waypoint]
    current_waypoint_idx: int
    speed: float
    mode: int


class DroneGateway:
    def __init__(self, host: str = '0.0.0.0', port: int = 9000):
        self.host = host
        self.port = port
        self.drones = self._init_drones()
        self.lock = threading.Lock()
        self.running = True
        self.status_interval = STATUS_INTERVAL

    def _init_drones(self) -> List[DroneState]:
        drones = []
        base_lat = 31.2304
        base_lng = 121.4737
        for i in range(DRONE_COUNT):
            angle = (2 * math.pi * i) / DRONE_COUNT
            radius = 0.002
            drones.append(DroneState(
                id=i,
                lat=base_lat + math.sin(angle) * radius,
                lng=base_lng + math.cos(angle) * radius,
                alt=100.0 + i * 10,
                battery=100,
                roll=0.0,
                pitch=0.0,
                yaw=angle,
                status=1,
                target_waypoints=[],
                current_waypoint_idx=0,
                speed=5.0,
                mode=FLIGHT_MODE_HOVER
            ))
        return drones

    def _parse_command(self, data: bytes) -> Tuple[int, dict]:
        if len(data) < 5:
            return -1, {}

        magic, msg_type, length = struct.unpack('>HBH', data[:5])
        if magic != MAGIC:
            return -1, {}

        if msg_type == MSG_TYPE_COMMAND:
            payload = data[5:5 + length]
            if len(payload) < 3:
                return -1, {}

            drone_id = payload[0]
            waypoint_count = payload[1]
            offset = 2
            waypoints = []

            for _ in range(waypoint_count):
                if offset + 20 > len(payload):
                    break
                lat, lng, alt = struct.unpack('>ddf', payload[offset:offset + 20])
                waypoints.append(Waypoint(lat, lng, alt))
                offset += 20

            speed, mode = struct.unpack('>fB', payload[offset:offset + 5])
            return msg_type, {
                'drone_id': drone_id,
                'waypoints': waypoints,
                'speed': speed,
                'mode': mode
            }
        elif msg_type == MSG_TYPE_SET_RATE:
            payload = data[5:5 + length]
            if len(payload) < 4:
                return -1, {}
            interval_ms = struct.unpack('>I', payload[:4])[0]
            return msg_type, {
                'interval_ms': interval_ms
            }

        return msg_type, {}

    def _encode_status(self) -> bytes:
        with self.lock:
            header = struct.pack('>HBB', MAGIC, MSG_TYPE_STATUS, DRONE_COUNT)
            payload = b''
            for drone in self.drones:
                payload += struct.pack(
                    '>BddfHfffB',
                    drone.id,
                    drone.lat,
                    drone.lng,
                    drone.alt,
                    int(drone.battery),
                    drone.roll,
                    drone.pitch,
                    drone.yaw,
                    drone.status
                )
            return header + payload

    def _encode_ack(self, success: bool) -> bytes:
        return struct.pack('>HBHB', MAGIC, MSG_TYPE_ACK, 1, 1 if success else 0)

    def _update_drones(self):
        while self.running:
            start_time = time.time()
            with self.lock:
                for drone in self.drones:
                    if drone.mode == FLIGHT_MODE_WAYPOINT and drone.target_waypoints:
                        if drone.current_waypoint_idx < len(drone.target_waypoints):
                            target = drone.target_waypoints[drone.current_waypoint_idx]
                            dlat = target.lat - drone.lat
                            dlng = target.lng - drone.lng
                            dalt = target.alt - drone.alt
                            dist = math.sqrt(dlat ** 2 + dlng ** 2 + dalt ** 2)

                            if dist < 0.0001:
                                drone.current_waypoint_idx += 1
                                if drone.current_waypoint_idx >= len(drone.target_waypoints):
                                    drone.mode = FLIGHT_MODE_HOVER
                            else:
                                move_speed = min(drone.speed * 0.00001, dist)
                                ratio = move_speed / dist
                                drone.lat += dlat * ratio
                                drone.lng += dlng * ratio
                                drone.alt += dalt * ratio
                                drone.yaw = math.atan2(dlat, dlng)
                                drone.pitch = math.sin(dalt / max(dist, 0.0001)) * 0.3

                    drone.battery = max(0, drone.battery - 0.01)
                    if drone.battery < 20 and drone.mode != FLIGHT_MODE_RETURN:
                        drone.mode = FLIGHT_MODE_RETURN

            elapsed = time.time() - start_time
            sleep_time = max(0, 0.05 - elapsed)
            time.sleep(sleep_time)

    def _send_status_loop(self, conn: socket.socket):
        while self.running:
            try:
                status_data = self._encode_status()
                conn.sendall(status_data)
                time.sleep(self.status_interval)
            except Exception as e:
                print(f"Status send error: {e}")
                break

    def _handle_client(self, conn: socket.socket, addr):
        print(f"Client connected: {addr}")
        try:
            status_thread = threading.Thread(target=self._send_status_loop, args=(conn,), daemon=True)
            status_thread.start()

            buffer = b''
            while self.running:
                data = conn.recv(4096)
                if not data:
                    break
                buffer += data

                while len(buffer) >= 5:
                    magic, msg_type, length = struct.unpack('>HBH', buffer[:5])
                    if magic != MAGIC:
                        buffer = buffer[1:]
                        continue

                    total_len = 5 + length
                    if len(buffer) < total_len:
                        break

                    packet = buffer[:total_len]
                    buffer = buffer[total_len:]

                    msg_type_parsed, cmd = self._parse_command(packet)
                    if msg_type_parsed == MSG_TYPE_COMMAND:
                        with self.lock:
                            drone_id = cmd['drone_id']
                            if 0 <= drone_id < len(self.drones):
                                drone = self.drones[drone_id]
                                drone.target_waypoints = cmd['waypoints']
                                drone.current_waypoint_idx = 0
                                drone.speed = cmd['speed']
                                drone.mode = cmd['mode']
                                conn.sendall(self._encode_ack(True))
                            else:
                                conn.sendall(self._encode_ack(False))
                    elif msg_type_parsed == MSG_TYPE_SET_RATE:
                        interval_ms = cmd['interval_ms']
                        self.status_interval = max(0.02, min(5.0, interval_ms / 1000.0))
                        print(f"Status rate set to {1.0/self.status_interval:.1f}/s (interval={self.status_interval*1000:.0f}ms)")
                        conn.sendall(self._encode_ack(True))

        except Exception as e:
            print(f"Client error: {e}")
        finally:
            print(f"Client disconnected: {addr}")
            conn.close()

    def start(self):
        update_thread = threading.Thread(target=self._update_drones, daemon=True)
        update_thread.start()

        server_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server_socket.bind((self.host, self.port))
        server_socket.listen(1)

        print(f"Drone Gateway listening on {self.host}:{self.port}")
        print(f"Simulating {DRONE_COUNT} drones")

        try:
            while self.running:
                conn, addr = server_socket.accept()
                client_thread = threading.Thread(
                    target=self._handle_client,
                    args=(conn, addr),
                    daemon=True
                )
                client_thread.start()
        except KeyboardInterrupt:
            print("\nShutting down...")
            self.running = False
        finally:
            server_socket.close()


if __name__ == '__main__':
    gateway = DroneGateway()
    gateway.start()
