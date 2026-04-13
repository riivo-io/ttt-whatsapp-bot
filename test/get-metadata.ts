import { dynamicsService } from '../src/services/dynamics.service';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

async function getMetadata() {
    console.log('Fetching Metadata for riivo_messagedirection...');
    // We need to access the private token method or just use a raw axios call with the service's logic duplicated strictly for this debug script
    // Or simpler: I'll just make `getToken` public-ish or use a dirty cast? No, I'll just copy the auth logic briefly or add a getMetadata method to the service?
    // Let's add a public helper to the service for this investigation.
    // Actually, I can just use the service to get a token if I expose it, but it's private. 
    // I'll modify the service to allow raw requests or just add a temporary method.
    // Let's modify the service to log the error details better, or just add a method to get OptionSet values.

    // Quickest way: Use the service instance but cast it to any to access private members for this one-off test.
    try {
        const service = dynamicsService as any;
        const token = await service.getToken();

        const url = `${service.baseUrl}/api/data/v9.2/EntityDefinitions(LogicalName='new_invoice')?$select=EntitySetName`;

        const response = await axios.get(url, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/json'
            }
        });

        console.log(JSON.stringify(response.data, null, 2));

    } catch (error: any) {
        console.error('Metadata fetch failed:', error?.response?.data || error.message);
    }
}

getMetadata();
