// The scene kit (remotion/kit) imports font files; the app build now reaches it through the Preview tab.
declare module "*.ttf" {
  const url: string;
  export default url;
}
