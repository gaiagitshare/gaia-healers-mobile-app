#!/bin/bash

echo "Starting Event Management System for ba2ki.com/event..."

cd ~/event/backend

echo "Starting backend on port 8002..."
nohup python3 -m uvicorn main:app --host 0.0.0.0 --port 8002 --reload > backend.log 2>&1 &
echo $! > backend.pid
echo "Backend started (PID: $(cat backend.pid))"

cd ~/event/frontend

echo "Installing dependencies (if needed)..."
npm install --silent

echo "Starting frontend on port 3002..."
nohup npm start > frontend.log 2>&1 &
echo $! > frontend.pid
echo "Frontend started (PID: $(cat frontend.pid))"

echo ""
echo "=========================================="
echo "Event System is running!"
echo ""
echo "Local access:"
echo "  Frontend: http://localhost:3002"
echo "  Backend:  http://localhost:8002"
echo ""
echo "Via domain (after DNS update):"
echo "  http://ba2ki.com/event"
echo "  http://ba2ki.com/event-api/docs"
echo "=========================================="
echo ""
echo "To stop: ./STOP_BA2KI.sh"
