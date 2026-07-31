
from PIL import Image
import numpy as np
import sys

def check_tile(path):
    try:
        img = Image.open(path)
        img.verify() # Verify it's a valid PNG
        print(f"✅ {path} is a valid PNG according to PIL.verify()")
        
        img = Image.open(path)
        data = np.array(img)
        print(f"📊 Shape: {data.shape}, Dtype: {data.dtype}")
        print(f"✨ First 5x5 alpha values:\n{data[:5, :5, 3]}")
    except Exception as e:
        print(f"❌ {path} is INVALID: {e}")

if __name__ == "__main__":
    check_tile(sys.argv[1])
