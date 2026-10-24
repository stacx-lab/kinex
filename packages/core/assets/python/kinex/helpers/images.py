"""Camera images: pixel arrays for computation and files for finish()."""

from kinex.lib.camera import array, save


def image_array(image):
    """Native-order pixels of a sensor_msgs/Image as numpy: HxWx3 RGB or HxW mono8/16UC1.

    Example: pixels = helpers.image_array((await io.request("camera.capture")).image)
    """
    return array(image)


def save_image(image):
    """Write a sensor_msgs/Image as a PNG, keeping 16-bit depth, and return its path.

    Example: finish({"stamp": stamp}, file=helpers.save_image(capture.image))
    """
    return save(image)
