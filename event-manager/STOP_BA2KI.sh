#!/bin/bash

echo "Stopping Event Management System..."

if [ -f ~/event/backend/backend.pid ]; then
    kill $(cat ~/event/backend/backend.pid) 2>/dev/null
    rm ~/event/backend/backend.pid
    echo "✓ Backend stopped"
fi

if [ -f ~/event/frontend/frontend.pid ]; then
    kill $(cat ~/event/frontend/frontend.pid) 2>/dev/null
    rm ~/event/frontend/frontend.pid
    echo "✓ Frontend stopped"
fi

echo "Done!"
