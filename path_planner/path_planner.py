import redis
import json
import time
import math
import threading
import uuid
from dataclasses import dataclass, asdict
from typing import List, Tuple, Dict, Optional
from collections import deque

REDIS_HOST = '127.0.0.1'
REDIS_PORT = 6379
REQUEST_CHANNEL = 'path_planner:requests'
RESPONSE_CHANNEL_PREFIX = 'path_planner:response:'

MAX_SPEED = 10.0
MAX_ACCEL = 2.0
MAX_TURN_RATE = 0.5
MIN_SPACING = 0.0003
OBSTACLE_AVOIDANCE_DISTANCE = 0.0008

@dataclass
class DroneState:
    id: int
    lat: float
    lng: float
    alt: float
    roll: float = 0.0
    pitch: float = 0.0
    yaw: float = 0.0

@dataclass
class TargetPosition:
    lat: float
    lng: float
    alt: float

@dataclass
class TrajectoryPoint:
    drone_id: int
    lat: float
    lng: float
    alt: float
    timestamp: float
    speed: float

@dataclass
class Obstacle:
    lat: float
    lng: float
    radius: float
    height: float

class PathPlanner:
    def __init__(self):
        self.redis = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)
        self.pubsub = self.redis.pubsub()
        self.active_requests = {}
        self.request_queue = deque()
        self.running = True
        self.obstacles = self._init_obstacles()
        
        self.pubsub.subscribe(**{REQUEST_CHANNEL: self._handle_request})
        
        print(f"Path Planner started on redis://{REDIS_HOST}:{REDIS_PORT}")
        print(f"Listening on channel: {REQUEST_CHANNEL}")

    def _init_obstacles(self) -> List[Obstacle]:
        base_lat = 31.2304
        base_lng = 121.4737
        return [
            Obstacle(base_lat + 0.001, base_lng + 0.001, 0.0003, 80),
            Obstacle(base_lat - 0.0015, base_lng - 0.0005, 0.0004, 120),
            Obstacle(base_lat + 0.0005, base_lng - 0.001, 0.00025, 60),
        ]

    def _handle_request(self, message):
        if message['type'] != 'message':
            return
        
        try:
            request = json.loads(message['data'])
            request_id = request.get('request_id', str(uuid.uuid4()))
            request['request_id'] = request_id
            
            self.request_queue.append(request)
            print(f"Received planning request: {request_id}")
            
            threading.Thread(
                target=self._process_request,
                args=(request,),
                daemon=True
            ).start()
            
        except Exception as e:
            print(f"Error handling request: {e}")

    def _process_request(self, request):
        request_id = request['request_id']
        response_channel = RESPONSE_CHANNEL_PREFIX + request_id
        
        try:
            drones = [DroneState(**d) for d in request['drones']]
            targets = [TargetPosition(**t) for t in request['targets']]
            speed = request.get('speed', 5.0)
            
            self._publish_progress(response_channel, 'started', {'drone_count': len(drones)})
            
            trajectories = self._plan_trajectories(drones, targets, speed, response_channel)
            
            self._publish_progress(response_channel, 'completed', {
                'trajectory_count': len(trajectories),
                'total_points': sum(len(t) for t in trajectories.values())
            })
            
        except Exception as e:
            print(f"Planning error: {e}")
            self._publish_progress(response_channel, 'error', {'message': str(e)})

    def _publish_progress(self, channel, status, data):
        message = json.dumps({
            'status': status,
            'timestamp': time.time(),
            **data
        })
        self.redis.publish(channel, message)

    def _plan_trajectories(self, drones: List[DroneState], targets: List[TargetPosition], 
                          speed: float, response_channel: str) -> Dict[int, List[TrajectoryPoint]]:
        trajectories = {d.id: [] for d in drones}
        max_iterations = 500
        completed = set()
        
        drone_positions = {d.id: {'lat': d.lat, 'lng': d.lng, 'alt': d.alt, 'yaw': d.yaw} for d in drones}
        drone_speeds = {d.id: 0.0 for d in drones}
        
        for iteration in range(max_iterations):
            if len(completed) >= len(drones):
                break
            
            all_done = True
            iteration_points = []
            
            for i, drone in enumerate(drones):
                if drone.id in completed:
                    continue
                    
                target = targets[i] if i < len(targets) else targets[-1]
                current = drone_positions[drone.id]
                
                next_point, done = self._step(
                    current, target, speed, 
                    drone_speeds[drone.id], iteration,
                    drone_positions, drone.id
                )
                
                if done:
                    completed.add(drone.id)
                    trajectories[drone.id].append(TrajectoryPoint(
                        drone_id=drone.id,
                        lat=target.lat,
                        lng=target.lng,
                        alt=target.alt,
                        timestamp=time.time(),
                        speed=0.0
                    ))
                else:
                    all_done = False
                    drone_positions[drone.id] = {
                        'lat': next_point['lat'],
                        'lng': next_point['lng'],
                        'alt': next_point['alt'],
                        'yaw': next_point['yaw']
                    }
                    drone_speeds[drone.id] = next_point['speed']
                    
                    trajectories[drone.id].append(TrajectoryPoint(
                        drone_id=drone.id,
                        lat=next_point['lat'],
                        lng=next_point['lng'],
                        alt=next_point['alt'],
                        timestamp=time.time(),
                        speed=next_point['speed']
                    ))
                
                iteration_points.append({
                    'drone_id': drone.id,
                    'lat': next_point['lat'] if not done else target.lat,
                    'lng': next_point['lng'] if not done else target.lng,
                    'alt': next_point['alt'] if not done else target.alt,
                    'speed': next_point['speed'] if not done else 0.0,
                    'completed': done
                })
            
            if iteration % 10 == 0 and iteration_points:
                self._publish_progress(response_channel, 'progress', {
                    'iteration': iteration,
                    'completed': len(completed),
                    'total': len(drones),
                    'points': iteration_points
                })
            
            if all_done:
                break
            
            time.sleep(0.005)
        
        return trajectories

    def _step(self, current: Dict, target: TargetPosition, speed: float, 
             current_speed: float, iteration: int, all_positions: Dict, self_id: int
             ) -> Tuple[Dict, bool]:
        dlat = target.lat - current['lat']
        dlng = target.lng - current['lng']
        dalt = target.alt - current['alt']
        
        dist_2d = math.sqrt(dlat ** 2 + dlng ** 2)
        dist = math.sqrt(dist_2d ** 2 + dalt ** 2)
        
        if dist < 0.0001:
            return {
                'lat': target.lat,
                'lng': target.lng,
                'alt': target.alt,
                'yaw': current['yaw'],
                'speed': 0.0
            }, True
        
        step_size = min(speed * 0.00001, dist)
        
        avoid_vector = self._calculate_obstacle_avoidance(current, all_positions, self_id)
        
        base_ratio = step_size / dist if dist > 0 else 0
        avoid_weight = 0.3 if avoid_vector else 0
        
        move_lat = dlat * base_ratio + (avoid_vector['lat'] if avoid_vector else 0) * avoid_weight
        move_lng = dlng * base_ratio + (avoid_vector['lng'] if avoid_vector else 0) * avoid_weight
        move_alt = dalt * base_ratio + (avoid_vector['alt'] if avoid_vector else 0) * avoid_weight * 0.5
        
        spacing_vector = self._maintain_spacing(current, all_positions, self_id)
        if spacing_vector:
            move_lat += spacing_vector['lat'] * 0.2
            move_lng += spacing_vector['lng'] * 0.2
        
        target_yaw = math.atan2(move_lat, move_lng) if dist > 0 else current['yaw']
        yaw_diff = self._normalize_angle(target_yaw - current['yaw'])
        yaw_diff = max(-MAX_TURN_RATE, min(MAX_TURN_RATE, yaw_diff))
        new_yaw = self._normalize_angle(current['yaw'] + yaw_diff)
        
        current_speed = min(current_speed + MAX_ACCEL * 0.1, min(speed, speed * 0.00001 / max(0.00001, step_size)))
        
        return {
            'lat': current['lat'] + move_lat,
            'lng': current['lng'] + move_lng,
            'alt': current['alt'] + move_alt,
            'yaw': new_yaw,
            'speed': current_speed
        }, False

    def _calculate_obstacle_avoidance(self, current: Dict, all_positions: Dict, self_id: int) -> Optional[Dict]:
        avoid_lat = 0.0
        avoid_lng = 0.0
        avoid_alt = 0.0
        has_avoidance = False
        
        for obstacle in self.obstacles:
            dlat = current['lat'] - obstacle.lat
            dlng = current['lng'] - obstacle.lng
            dist = math.sqrt(dlat ** 2 + dlng ** 2)
            
            if dist < OBSTACLE_AVOIDANCE_DISTANCE + obstacle.radius:
                strength = 1.0 - dist / (OBSTACLE_AVOIDANCE_DISTANCE + obstacle.radius)
                avoid_lat += dlat * strength * 0.00005
                avoid_lng += dlng * strength * 0.00005
                if current['alt'] < obstacle.height:
                    avoid_alt += strength * 5
                has_avoidance = True
        
        return {'lat': avoid_lat, 'lng': avoid_lng, 'alt': avoid_alt} if has_avoidance else None

    def _maintain_spacing(self, current: Dict, all_positions: Dict, self_id: int) -> Optional[Dict]:
        repel_lat = 0.0
        repel_lng = 0.0
        has_repel = False
        
        for other_id, other_pos in all_positions.items():
            if other_id == self_id:
                continue
            
            dlat = current['lat'] - other_pos['lat']
            dlng = current['lng'] - other_pos['lng']
            dist = math.sqrt(dlat ** 2 + dlng ** 2)
            
            if dist < MIN_SPACING:
                strength = 1.0 - dist / MIN_SPACING
                repel_lat += dlat * strength * 0.00002
                repel_lng += dlng * strength * 0.00002
                has_repel = True
        
        return {'lat': repel_lat, 'lng': repel_lng, 'alt': 0} if has_repel else None

    def _normalize_angle(self, angle: float) -> float:
        while angle > math.pi:
            angle -= 2 * math.pi
        while angle < -math.pi:
            angle += 2 * math.pi
        return angle

    def run(self):
        try:
            while self.running:
                self.pubsub.get_message(timeout=1)
        except KeyboardInterrupt:
            print("\nShutting down path planner...")
            self.running = False
        finally:
            self.pubsub.close()
            self.redis.close()

if __name__ == '__main__':
    planner = PathPlanner()
    planner.run()
