import axios from 'axios';

const apiBase = process.env.API_BASE_URL || `http://localhost:${process.env.BACKEND_PORT || '9091'}`;

async function testBilibiliAPI() {
  try {
    console.log('Testing Bilibili video processing API...');
    
    const response = await axios.post(`${apiBase}/api/process-video`, {
      url: 'https://www.bilibili.com/video/BV1GdCsBPEvE/?share_source=copy_web&vd_source=eb46e9ffc765ae89070146d6c4acb4e7',
      accessKey: 'sk-a9c7af3a35d14b32af8278201f4d5970'
    });
    
    console.log('Response status:', response.status);
    console.log('Response data:', JSON.stringify(response.data, null, 2));
  } catch (error) {
    console.error('API Error:', error.response?.data || error.message);
    if (error.response?.data?.error) {
      console.error('Error details:', error.response.data.error);
    }
  }
}

testBilibiliAPI();
