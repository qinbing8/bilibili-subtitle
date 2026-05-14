import axios from 'axios';

const apiBase = process.env.API_BASE_URL || `http://localhost:${process.env.BACKEND_PORT || '9091'}`;

async function debugTingwuAPI() {
  try {
    console.log('Testing Tongyi Tingwu processing...');
    
    // First, download the video
    console.log('Step 1: Downloading video...');
    const downloadResponse = await axios.post(`${apiBase}/api/download-video`, {
      bilibiliUrl: 'https://www.bilibili.com/video/BV1GdCsBPEvE/?share_source=copy_web&vd_source=eb46e9ffc765ae89070146d6c4acb4e7'
    });
    
    console.log('Download response:', downloadResponse.data);
    
    if (downloadResponse.data.success) {
      const videoUrl = downloadResponse.data.data.videoUrl;
      const accessKey = 'sk-a9c7af3a35d14b32af8278201f4d5970';
      
      console.log('Step 2: Processing with Tongyi Tingwu...');
      console.log('Video URL:', videoUrl);
      console.log('Access Key present:', !!accessKey);
      console.log('Access Key starts with sk-:', accessKey.startsWith('sk-'));
      
      const tingwuResponse = await axios.post(`${apiBase}/api/tingwu-process`, {
        videoUrl: videoUrl,
        accessKey: accessKey,
        language: 'auto'
      });
      
      console.log('Tingwu response:', JSON.stringify(tingwuResponse.data, null, 2));
    }
    
  } catch (error) {
    console.error('Full error details:');
    console.error('Error message:', error.message);
    console.error('Error response:', error.response?.data);
    console.error('Error status:', error.response?.status);
    console.error('Error headers:', error.response?.headers);
  }
}

debugTingwuAPI();
