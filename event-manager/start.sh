#!/bin/bash

echo "Starting Event Management System..."

# Install backend dependencies
cd backend
pip install -r requirements.txt

# Start backend in background
echo "Starting backend on port 8002..."
uvicorn main:app --host 0.0.0.0 --port 8002 --reload &
BACKEND_PID=$!

# Wait for backend to start
sleep 3

# Install frontend dependencies
cd ../frontend
npm install

# Start frontend
echo "Starting frontend on port 3002..."
PORT=3002 npm start &
FRONTEND_PID=$!

echo ""
echo "=========================================="
echo "Event Management System is running!"
echo "Backend: http://localhost:8002"
echo "Frontend: http://localhost:3002"
echo "API Docs: http://localhost:8002/docs"
echo "=========================================="
echo ""
echo "Press Ctrl+C to stop both services"

# Wait for interrupt
trap "kill $BACKEND_PID $FRONTEND_PID; exit" INT
wait
