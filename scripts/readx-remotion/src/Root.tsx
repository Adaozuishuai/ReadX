import {Composition} from 'remotion';
import {ReadXPromo} from './ReadXPromo';
import {ScholiaStylePromo} from './ScholiaStylePromo';

export const RemotionRoot = () => (
  <>
    <Composition
      id="ReadXPromo"
      component={ReadXPromo}
      durationInFrames={828}
      fps={30}
      width={1920}
      height={1080}
    />
    <Composition
      id="ReadXEditorialPromo"
      component={ScholiaStylePromo}
      durationInFrames={1224}
      fps={30}
      width={1920}
      height={1080}
    />
  </>
);
