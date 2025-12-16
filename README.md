# Spring-Foliage
Short and Simple: Interactive US map that shows the progression of Spring across the U.S. over time, using a date slider to visualize peak foliage by region.
Demo Video: https://youtu.be/J9V05LNUCoU



https://github.com/user-attachments/assets/92ee911f-51ec-41ef-abdb-fb974d25dc54



###Current Issue: Rendering is too intensive


https://github.com/user-attachments/assets/5e70ae09-e687-42b3-a2ea-2f07285b0206



Optimizing Before Deployment. The Current Map rerenders the entire map for every date, causing memory drag and large GPU performance demands.
Current Plan: Developing a data generator that creates the data once for the client. As the user zooms in, tiles will get smaller and more detailed.

Future Plan: Download topography data to avoid extra API usage.



## Getting Started

### Prerequisites
- Node.js (v16 or higher)
- npm
- MapTiler API key (free tier available at [maptiler.com](https://maptiler.com))

### Installation

1. Clone the repository
```bash
git clone <repository-url>
cd Spring-Foliage
```

2. Install dependencies
```bash
cd client
npm install
```

3. Set up environment variables
   - Create a `.env` file in the `client` folder
   - Add your MapTiler API key:
```
VITE_MAPTILER_KEY=your_api_key_here
```

4. Run the development server
```bash
npm run dev
```

5. Open your browser to the URL shown in the terminal (typically `http://localhost:5173`)

### Building for Production
```bash
npm run build
npm run preview
```



Title: Spring Foliage Map

Objective: The objective of the Spring Foliage Map is to create an easy-to-access, predictive geographic model of the foliage in the spring of the following year. It should be easy for any user to engage with it, with a sliding bar at the bottom allowing the user to change the date, and the map changing accordingly. 

The Spring Foliage Map provides scientific use for any audience, from researchers to Leafers. Importance: The map's importance lies in its ability to show the user the impact of temperature, latitude, and sunlight on foliage across the United States. Additionally, users can plan trips to see their favorite aspects of the beautiful spring season. 

Originality: Surprisingly, while a Fall Foliage map exists, providing powerful and accurate fall foliage reports around the country, no such map exists for the sibling of Autumn, Spring. 


Data Interaction with Map:
| Stage      | Formula (relative to First Bloom DOY) |
| ---------- | ------------------------------------- |
| None       | Before First Bloom − 15 days          |
| Budding    | First Bloom − 10 days                 |
| First Leaf | First Bloom − 5 days                  |
| Bloom      | First Bloom                           |
| Peak Bloom | First Bloom + 3 days                  |
| Canopy     | First Bloom + 10 days                 |
| Post       | First Bloom + 20–30 days              |

