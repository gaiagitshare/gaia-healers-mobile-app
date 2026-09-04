#!/usr/bin/env python3
"""
Import attendees from GoHighLevel CSV export
Usage: python import_ghl.py <event_id> <ghl_csv_file>
"""

import csv
import sys
import requests
from datetime import datetime

API_BASE_URL = "http://localhost:8002"

def import_attendees_from_ghl(event_id, csv_file_path):
    """
    Import attendees from GHL CSV export
    Expected CSV columns from GHL:
    - First Name
    - Last Name  
    - Email
    - Phone
    - Company
    - Additional fields as needed
    """
    
    # Login to get token (you'll need to create an admin user first)
    print("Note: Make sure you've created an admin user via /auth/register first")
    
    attendees_imported = 0
    errors = []
    
    with open(csv_file_path, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        
        for row in reader:
            try:
                # Map GHL fields to our schema
                attendee_data = {
                    "event_id": event_id,
                    "first_name": row.get('First Name', row.get('first_name', '')).strip(),
                    "last_name": row.get('Last Name', row.get('last_name', '')).strip(),
                    "email": row.get('Email', row.get('email', '')).strip(),
                    "phone": row.get('Phone', row.get('phone', '')).strip(),
                    "company": row.get('Company', row.get('company', '')).strip(),
                    "job_title": row.get('Job Title', row.get('job_title', '')).strip(),
                    "custom_data": {}
                }
                
                # Add any extra fields to custom_data
                for key, value in row.items():
                    if key not in ['First Name', 'Last Name', 'Email', 'Phone', 'Company', 'Job Title',
                                   'first_name', 'last_name', 'email', 'phone', 'company', 'job_title']:
                        if value and value.strip():
                            attendee_data['custom_data'][key] = value.strip()
                
                # Skip if no email
                if not attendee_data['email']:
                    errors.append(f"Skipping row: no email address")
                    continue
                
                # Register via public API
                response = requests.post(
                    f"{API_BASE_URL}/register",
                    json=attendee_data
                )
                
                if response.status_code == 200:
                    attendees_imported += 1
                    print(f"✓ Imported: {attendee_data['first_name']} {attendee_data['last_name']} ({attendee_data['email']})")
                elif response.status_code == 400 and "already registered" in response.text:
                    print(f"⚠ Already registered: {attendee_data['email']}")
                else:
                    errors.append(f"Failed to import {attendee_data['email']}: {response.text}")
                    
            except Exception as e:
                errors.append(f"Error processing row: {str(e)}")
    
    print(f"\n{'='*50}")
    print(f"Import Complete!")
    print(f"Attendees imported: {attendees_imported}")
    print(f"Errors: {len(errors)}")
    
    if errors:
        print(f"\nErrors encountered:")
        for error in errors[:10]:  # Show first 10 errors
            print(f"  - {error}")
        if len(errors) > 10:
            print(f"  ... and {len(errors) - 10} more")
    
    return attendees_imported

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python import_ghl.py <event_id> <ghl_csv_file>")
        print("\nExample:")
        print("  python import_ghl.py 1 /path/to/ghl_export.csv")
        sys.exit(1)
    
    event_id = int(sys.argv[1])
    csv_file = sys.argv[2]
    
    import_attendees_from_ghl(event_id, csv_file)
